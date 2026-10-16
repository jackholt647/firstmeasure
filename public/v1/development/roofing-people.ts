/**
 * Development-only: the people of a residential and commercial roofing contractor, built from the platform's own
 * concepts so the People settings show what a real company looks like. Access roles (a user's types are their roles),
 * departments with icons, colours and department-scoped roles, group types whose `member_role_ids` are given on
 * joining, groups with leads and staffing requirements, company types, assignment tags, people fields defined on
 * roles, group types and company types, worker classification, and pay through pay defaults built from the sample
 * pay rules. See docs/architecture/assignee-base.md, pay-rules.md and custom-fields.md.
 *
 * Safe to run again. Records it made carry `metadata.source = development_roofing_company` (roles, users, groups and
 * companies) or the note below (pay), and are brought up to this definition. Anything else in the organization is
 * reused, never deleted: lists of roles, members, tags, types and department members only ever grow, a role, type,
 * department or pay default that someone else made keeps its own settings, and a field value someone typed wins over
 * the sample value.
 *
 * Nothing here sends anything. People are organization user records with no login identity and are never invited;
 * addresses are @example.test and phone numbers are in the 555-01xx range set aside for fiction. Companies are
 * unlinked. People get no notification roles (`roles` stays empty), so lead notifications that target those roles
 * never select them.
 */
import { appDefinitions, type AppDefinition } from '../platform/app-experience/registry.js';
import { deviceTypeIds } from '../platform/app-experience/devices.js';
import { createHash } from 'node:crypto';
import { env } from '../src/config/env.js';
import type { PlatformAuthContext } from '../platform/auth.js';
import { hasPermission } from '../platform/auth.js';
import { forbidden, notFound, PlatformError } from '../platform/errors.js';
import { listDocuments, readDocument, readOrganization, upsertDocument, type JsonObject } from '../platform/storage.js';

export const PEOPLE_SOURCE = 'development_roofing_company';
const VERSION = 3;
const metadata = { synthetic: true, source: PEOPLE_SOURCE, version: VERSION };
/** Marks pay entries this generator wrote, so a later run can tell them from someone's own. */
export const PAY_NOTE = 'Synthetic roofing company sample';
/** Every pay entry the generator writes starts here, so a run in another year changes nothing already earned. */
const PAY_FROM = '2026-01-01';

const text = (value: unknown) => String(value ?? '').trim();
const obj = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown) => [...new Set(list(value).map(text).filter(Boolean))];
const union = (...lists: unknown[]) => [...new Set(lists.flatMap(strings))];
const ours = (meta: unknown) => text(obj(meta).source) === PEOPLE_SOURCE;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as JsonObject)[key])])) : value;
/** Whether a write would change nothing, so a repeat run can skip it. */
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const unchanged = (patch: JsonObject, current: JsonObject) => Object.entries(patch).every(([key, value]) => same(value, current[key]));
/** The same stable ids roofing-company.ts gives its people, so the six original team members are updated, not doubled. */
export const stableId = (org: string, key: string) => 'sample_' + createHash('sha256').update(`${org}:roofing-company:${key}`).digest('hex').slice(0, 24);
const missing = async <T>(run: () => Promise<T>): Promise<T | null> => {
  try { return await run(); } catch (error) { if ((error as PlatformError)?.statusCode === 404 || (error as { code?: string })?.code === 'not_found') return null; throw error; }
};

// ---- Roles --------------------------------------------------------------------------------------------------------
/** `only`: the role sees exactly the apps it shows. `clock`: Today shows the time clock. */
type RoleSpec = { id: string; name: string; description: string; only?: boolean; clock?: boolean; level: number; permissions: string[]; base?: string[]; show?: string[]; hide?: string[]; field?: string[]; params?: Record<string, JsonObject>; departmentOnly?: boolean };
const SUPERVISOR_FIELD = ['crew.dashboard.view', 'crew.projects.view', 'crew.projects.view_all_production', 'crew.schedule.view', 'crew.receipts.upload', 'crew.reimbursements.request', 'crew.materials.view', 'crew.materials.append', 'crew.checklists.view', 'crew.checklists.complete', 'crew.checklists.manage', 'crew.checklists.supervise', 'crew.change_orders.view', 'crew.change_orders.manage', 'crew.payments.view', 'crew.signatures.present', 'crew.workflows.add'];
const SUPERVISOR_APPS = ['portal.crew_overview', 'portal.crew_schedule', 'portal.crew_receipts', 'project.crew_overview', 'project.field_customer', 'project.crew_materials', 'project.crew_checklists', 'project.crew_change_orders', 'project.crew_payments', 'project.crew_signatures'];
const SALES_FIELD = ['sales.dashboard.view', 'sales.schedule.view', 'sales.followups.manage', 'sales.earnings.view', 'sales.documents.view_status', 'sales.money.view_status', 'sales.stats.view_own', 'crew.projects.view', 'crew.signatures.present', 'crew.workflows.add', 'crew.checklists.view', 'crew.checklists.complete'];
const SALES_APPS = ['portal.sales_overview', 'portal.sales_schedule', 'portal.sales_earnings', 'project.sales_overview', 'project.field_customer', 'project.crew_signatures', 'project.crew_checklists'];
const OFFICE_READ = ['view_projects', 'view_contacts', 'view_schedule', 'view_documents', 'view_proposals', 'view_media', 'view_comms', 'view_customer_portals', 'view_project_data'];
const MONEY_TABS = ['portal.payroll', 'portal.financials', 'portal.invoices'];

/** Custom roles a roofing company adds beside the seeded ones. Managers' powers start from the seeded Manager role. */
export const ROOFING_ROLES: RoleSpec[] = [
  // Given inside one department only (scoped_access_assignments), so it holds only what a department scope can carry.
  { id: 'department_manager', name: 'Department Manager', description: 'Manages projects, schedules and proposals inside the departments it is given for.', level: 21, base: ['manager'], permissions: [], departmentOnly: true },
  { id: 'office_manager', name: 'Office Manager', description: 'Runs the office: people, billing, payroll entry and day-to-day operations.', level: 25, base: ['manager'],
    permissions: ['manage_company_users', 'manage_payroll', 'view_financials', 'manage_project_billing', 'send_communications'], show: MONEY_TABS, hide: ['portal.canvassing'] },
  { id: 'csr', name: 'Customer Service Rep', description: 'Answers customers, books inspections and keeps jobs and contacts up to date.', level: 12,
    permissions: [...OFFICE_READ, 'manage_projects', 'manage_schedule', 'manage_media', 'send_communications', 'request_feedback', 'view_feedback'],
    show: ['portal.contacts', 'portal.scheduling', 'portal.chat'], hide: [...MONEY_TABS, 'portal.canvassing', 'portal.company_settings', 'project.money'] },
  { id: 'bookkeeper', name: 'Bookkeeper', description: 'Invoices, payments, job costing and payroll.', level: 18,
    permissions: ['view_projects', 'view_contacts', 'view_documents', 'view_proposals', 'view_materials', 'view_pricebook', 'view_reports', 'view_stats', 'view_project_data', 'view_financials', 'manage_project_billing', 'manage_payroll'],
    show: MONEY_TABS, hide: ['portal.canvassing', 'portal.chat', 'portal.photos_feed', 'portal.scheduling', 'project.customer_portal', 'project.measurements'] },
  { id: 'production_coordinator', name: 'Production Coordinator', description: 'Dispatch: schedules crews, orders and confirms material deliveries, and keeps customers informed.', level: 15,
    permissions: [...OFFICE_READ, 'view_materials', 'view_pricebook', 'manage_projects', 'manage_schedule', 'manage_media', 'send_communications', 'equipment.view'],
    show: ['portal.scheduling'], hide: [...MONEY_TABS, 'portal.canvassing'] },
  { id: 'project_manager', clock: true, name: 'Project Manager', description: 'Runs jobs from contract to completion: walks the job, supervises crews and closes out with the customer.', level: 22,
    permissions: [...OFFICE_READ, 'view_materials', 'manage_projects', 'manage_schedule', 'manage_media', 'send_communications', ...SUPERVISOR_FIELD],
    hide: [...MONEY_TABS, 'portal.canvassing'], field: SUPERVISOR_APPS, params: { 'portal.crew_overview': { variant: 'supervisor' }, 'project.crew_checklists': { mode: 'manage' }, 'project.crew_signatures': { mode: 'present' } } },
  { id: 'production_manager', clock: true, name: 'Production Manager', description: 'Owns production: crews, subcontractors, schedule, quality and equipment.', level: 28,
    permissions: [...OFFICE_READ, 'view_materials', 'view_pricebook', 'view_reports', 'view_stats', 'view_financials', 'manage_projects', 'manage_schedule', 'manage_media', 'send_communications', 'equipment.view', 'equipment.manage', ...SUPERVISOR_FIELD],
    show: ['portal.financials'], hide: ['portal.payroll', 'portal.invoices', 'portal.canvassing'], field: SUPERVISOR_APPS, params: { 'portal.crew_overview': { variant: 'supervisor' }, 'project.crew_checklists': { mode: 'manage' }, 'project.crew_signatures': { mode: 'present' } } },
  { id: 'sales_manager', name: 'Sales Manager', description: 'Leads the sales team: assigns leads, reviews proposals and team numbers.', level: 26,
    permissions: [...OFFICE_READ, 'view_stats', 'view_reports', 'view_pricebook', ...SALES_FIELD, 'sales.stats.view_team', 'crew.payments.view', 'crew.payments.take'],
    hide: MONEY_TABS, field: [...SALES_APPS, 'project.crew_payments'], params: { 'project.crew_signatures': { mode: 'present' }, 'project.crew_checklists': { mode: 'complete' } } },
  { id: 'estimator', name: 'Estimator', description: 'Inspects and measures roofs, builds estimates and presents proposals.', level: 20,
    permissions: ['view_projects', 'view_contacts', 'view_schedule', 'view_documents', 'view_proposals', 'view_media', 'view_pricebook', 'view_materials', 'view_reports', 'view_project_data', 'manage_projects', 'manage_documents', 'issue_documents', 'manage_proposals', 'send_proposals', 'manage_media', 'manage_project_data', 'order_reports', ...SALES_FIELD],
    hide: [...MONEY_TABS, 'portal.canvassing'], field: SALES_APPS, params: { 'project.crew_signatures': { mode: 'present' }, 'project.crew_checklists': { mode: 'complete' } } },
  { id: 'call_center_rep', name: 'Inside Sales Rep', description: 'Works inbound calls and web leads and books inspection appointments.', level: 10,
    permissions: ['view_projects', 'view_contacts', 'view_schedule', 'view_comms', 'view_proposals', 'manage_projects', 'manage_schedule', 'send_communications', 'sales.stats.view_own'],
    show: ['portal.contacts', 'portal.scheduling', 'portal.chat'], hide: [...MONEY_TABS, 'portal.photos_feed', 'portal.canvassing', 'portal.company_settings', 'project.money', 'project.measurements'] },
  { id: 'canvasser', name: 'Canvasser', description: 'Knocks doors after storms and sets inspection appointments.', only: true, level: 8,
    permissions: ['sales.dashboard.view', 'sales.schedule.view', 'sales.followups.manage', 'sales.earnings.view', 'sales.stats.view_own'],
    field: ['portal.sales_overview', 'portal.sales_schedule', 'portal.sales_earnings'] },
  { id: 'warehouse_lead', clock: true, name: 'Warehouse & Yard Lead', description: 'Receives and stages material, loads trucks and looks after the yard and equipment.', only: true, level: 14,
    permissions: ['crew.dashboard.view', 'crew.projects.view', 'crew.schedule.view', 'crew.receipts.upload', 'crew.reimbursements.request', 'crew.materials.view', 'crew.materials.append', 'equipment.view', 'equipment.manage'],
    field: ['portal.crew_overview', 'portal.crew_schedule', 'portal.crew_receipts', 'project.crew_overview', 'project.crew_materials'] },
  { id: 'delivery_driver', clock: true, name: 'Delivery Driver', description: 'Drives the boom truck and dump trailer: material drops and debris runs.', only: true, level: 9,
    permissions: ['crew.dashboard.view', 'crew.projects.view', 'crew.schedule.view', 'crew.receipts.upload', 'crew.materials.view'],
    field: ['portal.crew_overview', 'portal.crew_schedule', 'portal.crew_receipts', 'project.crew_overview', 'project.crew_materials', 'project.field_customer'] }
];

// ---- People -------------------------------------------------------------------------------------------------------
type Person = { key: string; name: string; title: string; roles: string[]; contractor?: boolean; tags?: string[]; fields?: JsonObject };
const CREW = { osha_10: true, shirt_size: 'L' };
/** 40 people. The first six keys are the original team in roofing-company.ts. Repair technicians hold the seeded Repairman role and belong to no group. */
export const ROOFING_PEOPLE: Person[] = [
  { key: 'alex', name: 'Alex Martinez', title: 'Production Manager', roles: ['production_manager'], fields: { csl_number: 'CS-000101 (sample)', csl_expires: '2027-06-30' } },
  { key: 'sam', name: 'Sam Rivera', title: 'Estimator', roles: ['estimator'], tags: ['storm_restoration'], fields: { haag_certified: true, hic_number: 'HIC-190001 (sample)', hic_expires: '2027-03-31', drivers_license_expires: '2029-02-14' } },
  { key: 'morgan', name: 'Morgan Lee', title: 'Office Manager', roles: ['office_manager'] },
  { key: 'chris', name: 'Chris Bennett', title: 'Crew Foreman', roles: ['crew_foreman', 'crew_member'], tags: ['steep_slope'], fields: { ...CREW, has_cdl: true, cdl_class: 'B', cdl_expires: '2028-05-31', csl_number: 'CS-000214 (sample)', csl_expires: '2027-09-30', shirt_size: 'XL' } },
  { key: 'jamie', name: 'Jamie Brooks', title: 'Roofing Installer', roles: ['crew_member'], tags: ['steep_slope'], fields: { ...CREW, has_cdl: false, fall_protection_trained: '2026-04-06' } },
  { key: 'dana', name: 'Dana Chen', title: 'Roofing Installer', roles: ['crew_member'], fields: { ...CREW, has_cdl: false, shirt_size: 'M', fall_protection_trained: '2026-04-06' } },
  { key: 'owner', name: 'Robert Kessler', title: 'Owner & President', roles: ['super_admin'] },
  { key: 'gm', name: 'Linda Okafor', title: 'General Manager', roles: ['admin'] },
  { key: 'priya', name: 'Priya Shah', title: 'Customer Service Rep', roles: ['csr'] },
  { key: 'nora', name: 'Nora Castillo', title: 'Customer Service Rep', roles: ['csr'], tags: ['spanish_speaking'] },
  { key: 'tom', name: 'Tom Becker', title: 'Bookkeeper', roles: ['bookkeeper'] },
  { key: 'renee', name: 'Renee Duval', title: 'Production Coordinator', roles: ['production_coordinator'] },
  { key: 'marcus', name: 'Marcus Hill', title: 'Project Manager — Residential', roles: ['project_manager'], fields: { csl_number: 'CS-000377 (sample)', csl_expires: '2027-12-31' } },
  { key: 'gina', name: 'Gina Russo', title: 'Project Manager — Commercial', roles: ['project_manager'], tags: ['commercial', 'low_slope'], fields: { csl_number: 'CS-000412 (sample)', csl_expires: '2026-12-31' } },
  { key: 'derek', name: 'Derek Lawson', title: 'Sales Manager', roles: ['sales_manager'], fields: { hic_number: 'HIC-190044 (sample)', hic_expires: '2027-03-31', drivers_license_expires: '2028-08-09' } },
  { key: 'hannah', name: 'Hannah Price', title: 'Commercial Estimator', roles: ['estimator'], tags: ['commercial', 'low_slope'], fields: { haag_certified: false, drivers_license_expires: '2030-01-22' } },
  { key: 'kyle', name: 'Kyle Brandt', title: 'Retail Sales Rep', roles: ['salesperson'], tags: ['storm_restoration'], fields: { hic_number: 'HIC-190102 (sample)', hic_expires: '2027-03-31', drivers_license_expires: '2028-11-03' } },
  { key: 'jasmine', name: 'Jasmine Ortiz', title: 'Retail Sales Rep', roles: ['salesperson'], tags: ['spanish_speaking'], fields: { hic_number: 'HIC-190117 (sample)', hic_expires: '2026-11-30', drivers_license_expires: '2027-05-19' } },
  { key: 'ben', name: 'Ben Whitaker', title: 'Retail Sales Rep', roles: ['salesperson'], fields: { drivers_license_expires: '2029-07-01' } },
  { key: 'tasha', name: 'Tasha Green', title: 'Inside Sales Rep', roles: ['call_center_rep'] },
  { key: 'owen', name: 'Owen Fitzgerald', title: 'Inside Sales Rep', roles: ['call_center_rep'] },
  { key: 'lucas', name: 'Lucas Moreau', title: 'Lead Canvasser', roles: ['canvasser'], contractor: true, tags: ['storm_restoration'], fields: { shirt_size: 'M', drivers_license_expires: '2028-03-12' } },
  { key: 'emma', name: 'Emma Clarke', title: 'Canvasser', roles: ['canvasser'], contractor: true, fields: { shirt_size: 'S' } },
  { key: 'luis', name: 'Luis Herrera', title: 'Roofing Installer', roles: ['crew_member'], tags: ['spanish_speaking'], fields: { ...CREW, has_cdl: false } },
  { key: 'mateo', name: 'Mateo Alvarez', title: 'Crew Foreman', roles: ['crew_foreman', 'crew_member'], tags: ['steep_slope', 'spanish_speaking'], fields: { ...CREW, has_cdl: true, cdl_class: 'B', cdl_expires: '2027-10-31', csl_number: 'CS-000233 (sample)', csl_expires: '2028-01-31' } },
  { key: 'ryan', name: "Ryan O'Neil", title: 'Roofing Installer', roles: ['crew_member'], tags: ['steep_slope'], fields: { ...CREW, has_cdl: false } },
  { key: 'kevin', name: 'Kevin Tran', title: 'Roofing Installer', roles: ['crew_member'], fields: { ...CREW, has_cdl: false, shirt_size: 'M' } },
  { key: 'andre', name: 'Andre Wallace', title: 'Roofing Installer', roles: ['crew_member'], fields: { ...CREW, has_cdl: true, shirt_size: '2XL' } },
  { key: 'sergio', name: 'Sergio Paz', title: 'Roofing Installer (1099)', roles: ['crew_member'], contractor: true, tags: ['spanish_speaking'], fields: { has_cdl: false, osha_10: false, shirt_size: 'L' } },
  { key: 'victor', name: 'Victor Novak', title: 'Crew Foreman — Low-Slope', roles: ['crew_foreman', 'crew_member'], tags: ['low_slope', 'commercial', 'metal_roofing'], fields: { ...CREW, has_cdl: true, cdl_class: 'A', cdl_expires: '2028-02-29', csl_number: 'CS-000298 (sample)', csl_expires: '2027-04-30' } },
  { key: 'eli', name: 'Eli Carter', title: 'Roofing Installer', roles: ['crew_member'], tags: ['low_slope'], fields: { ...CREW, has_cdl: false } },
  { key: 'javier', name: 'Javier Ruiz', title: 'Roofing Installer', roles: ['crew_member'], tags: ['low_slope', 'spanish_speaking'], fields: { ...CREW, has_cdl: false } },
  { key: 'nate', name: 'Nate Simmons', title: 'Roofing Installer', roles: ['crew_member'], fields: { ...CREW, has_cdl: false, shirt_size: 'XL' } },
  { key: 'frank', name: 'Frank DeLuca', title: 'Lead Service Technician', roles: ['repairman'], tags: ['skylights', 'chimney_flashing'], fields: { ...CREW, has_cdl: true } },
  { key: 'carlos', name: 'Carlos Medina', title: 'Service Technician', roles: ['repairman'], tags: ['chimney_flashing'], fields: { ...CREW, has_cdl: false } },
  { key: 'tyler', name: 'Tyler Quinn', title: 'Gutter Lead', roles: ['crew_foreman', 'crew_member'], tags: ['gutters'], fields: { ...CREW, has_cdl: false } },
  { key: 'sean', name: 'Sean Murphy', title: 'Gutter Installer', roles: ['crew_member'], tags: ['gutters'], fields: { ...CREW, has_cdl: false } },
  { key: 'marco', name: 'Marco Silva', title: 'Gutter Installer', roles: ['crew_member'], tags: ['gutters', 'spanish_speaking'], fields: { ...CREW, has_cdl: true } },
  { key: 'ray', name: 'Ray Dawson', title: 'Warehouse & Yard Lead', roles: ['warehouse_lead'], fields: { has_cdl: true, shirt_size: 'XL' } },
  { key: 'jake', name: 'Jake Porter', title: 'Delivery Driver', roles: ['delivery_driver'], fields: { has_cdl: true, cdl_class: 'A', cdl_expires: '2027-08-31', shirt_size: 'L' } }
];
const phoneOf = (index: number) => `(413) 555-01${String(index).padStart(2, '0')}`;

// ---- Tags, group types, groups ------------------------------------------------------------------------------------
export const ASSIGNMENT_TAGS = [['steep_slope', 'Steep slope (8/12 and up)'], ['low_slope', 'Low slope / flat roofing'], ['metal_roofing', 'Standing seam metal'], ['gutters', 'Seamless gutters'], ['siding', 'Siding'], ['skylights', 'Skylights'], ['chimney_flashing', 'Chimney & flashing'], ['storm_restoration', 'Storm / insurance restoration'], ['commercial', 'Commercial work'], ['spanish_speaking', 'Spanish-speaking']] as const;
/**
 * Group types are kinds of group, not kinds of work: every install crew is a Crew, and what a crew can do is its
 * capabilities (capability_scope_ids and declared kinds of work, labor/capabilities.ts). Repair technicians are people
 * with the seeded Repairman role, not a group.
 */
export const GROUP_TYPES = [
  { id: 'crew', name: 'Crew', description: 'An internal production team that can be assigned work as a unit.', member_role_ids: ['crew_member'] },
  { id: 'sales_team', name: 'Sales team', description: 'Retail sales reps who run appointments and close contracts.', member_role_ids: ['salesperson'] },
  { id: 'canvass_team', name: 'Canvassing team', description: 'Door-to-door canvassers who set inspection appointments.', member_role_ids: ['canvasser'] }
];
/** Types an earlier version of this generator made. A run moves its own groups off them and archives each one nobody else uses. */
export const RETIRED_GROUP_TYPES = [['shingle_crew', 'Shingle crew'], ['low_slope_crew', 'Low-slope crew'], ['service_crew', 'Repair & service'], ['gutter_crew', 'Gutter crew']] as const;
/** Groups an earlier version made that are no longer part of the company; archived while they are still the generator's. */
export const RETIRED_GROUPS = [{ key: 'service', names: ['Service & Repair (sample)'] }];
const lead = (label: string) => ({ id: 'lead', label, count: 1, where: { rules: [{ field: 'type_ids', operator: 'contains', value: 'crew_foreman' }] } });
const cdl = { id: 'cdl', label: 'CDL driver', count: 1, where: { rules: [{ field: 'fields.has_cdl', operator: 'equals', value: true }] } };
type GroupSpec = { key: string; name: string; formerNames: string[]; type: string; lead: string; members: string[]; tags: string[]; scopes: string[]; kinds: string[]; staffing: JsonObject[]; truck?: string };
/**
 * `scopes` are the kinds of work a crew is marked as doing (scope templates, `capability_scope_ids`); `kinds` are its
 * declared capabilities (labor/capabilities.ts). Crews 1 and 2 and the low-slope crew are the sample pay sheets' Crew A,
 * B and C (labor/sample-pay-sheets.ts), found by their former names and renamed, so a sandbox that has them is filled
 * in, not doubled.
 */
export const ROOFING_GROUPS: GroupSpec[] = [
  { key: 'crew_a', name: 'Crew 1 – Bennett', formerNames: ['Crew A (sample)'], type: 'crew', lead: 'chris', members: ['jamie', 'dana', 'luis'], tags: ['steep_slope'], scopes: ['roof_replacement', 'repairs'], kinds: ['roofing'], staffing: [lead('crew foreman'), cdl], truck: 'Crew truck 01 (F-350 + dump trailer)' },
  { key: 'crew_b', name: 'Crew 2 – Alvarez', formerNames: ['Crew B (sample)'], type: 'crew', lead: 'mateo', members: ['ryan', 'kevin', 'andre', 'sergio'], tags: ['steep_slope', 'storm_restoration'], scopes: ['roof_replacement', 'repairs'], kinds: ['roofing'], staffing: [lead('crew foreman'), cdl, { id: 'installers', label: 'installer', count: 3, where: { rules: [{ field: 'type_ids', operator: 'contains', value: 'crew_member' }] } }], truck: 'Crew truck 02 (dump truck)' },
  { key: 'crew_c', name: 'Low-slope Crew – Novak', formerNames: ['Crew C (sample)'], type: 'crew', lead: 'victor', members: ['eli', 'javier', 'nate'], tags: ['low_slope', 'commercial', 'metal_roofing'], scopes: ['roof_replacement', 'repairs', 'maintenance'], kinds: ['roofing'], staffing: [lead('crew foreman'), cdl], truck: 'Crew truck 03 (box truck)' },
  { key: 'gutters', name: 'Gutter Crew – Quinn', formerNames: ['Gutter Crew (sample)'], type: 'crew', lead: 'tyler', members: ['sean', 'marco'], tags: ['gutters'], scopes: ['gutters'], kinds: ['gutters'], staffing: [lead('gutter lead'), cdl], truck: 'Gutter machine trailer' },
  { key: 'sales', name: 'Sales Team', formerNames: ['Sales Team (sample)'], type: 'sales_team', lead: 'derek', members: ['kyle', 'jasmine', 'ben'], tags: [], scopes: [], kinds: [], staffing: [] },
  { key: 'canvass', name: 'Canvassing Team', formerNames: ['Canvassing Team (sample)'], type: 'canvass_team', lead: 'lucas', members: ['emma'], tags: ['storm_restoration'], scopes: [], kinds: [], staffing: [] }
];

// ---- Outside companies ----------------------------------------------------------------------------------------------
export const COMPANY_TYPES = [['install_subcontractor', 'Install subcontractor', 'Overflow roofing crews paid per committed labor list.'], ['gutter_subcontractor', 'Gutter subcontractor', 'Seamless gutters when our crew is booked.'], ['siding_subcontractor', 'Siding subcontractor', 'Siding and exterior trim.'], ['haul_off', 'Dumpster & haul-off', 'Roll-off dumpsters and debris removal.'], ['delivery_partner', 'Supplier delivery partner', 'Delivers material to the roof or the driveway.']] as const;
type CompanySpec = { key: string; name: string; legal: string; types: string[]; tags: string[]; contact: [string, string]; roles?: string[]; fields: JsonObject; scopes?: string[]; kinds?: string[] };
/** Summit and Ridgeline keep the names the sample pay sheets give them. */
export const ROOFING_COMPANIES: CompanySpec[] = [
  { key: 'summit', name: 'Summit Roofing (sample subcontractor)', legal: 'Summit Roofing LLC (sample)', types: ['install_subcontractor'], tags: ['steep_slope', 'storm_restoration'], contact: ['Gary Summers', 'Owner'], roles: ['crew_foreman'], fields: { coi_expires: '2027-01-31', workers_comp_on_file: true }, scopes: ['roof_replacement', 'repairs'], kinds: ['roofing'] },
  { key: 'ridgeline', name: 'Ridgeline Exteriors (sample subcontractor)', legal: 'Ridgeline Exteriors Inc. (sample)', types: ['install_subcontractor', 'siding_subcontractor'], tags: ['steep_slope', 'siding'], contact: ['Paula Ridge', 'Operations'], roles: ['crew_foreman'], fields: { coi_expires: '2026-11-15', workers_comp_on_file: true }, scopes: ['roof_replacement', 'siding_replacement'], kinds: ['roofing', 'siding'] },
  { key: 'valley_gutters', name: 'Valley Seamless Gutters (sample subcontractor)', legal: 'Valley Seamless Gutters LLC (sample)', types: ['gutter_subcontractor'], tags: ['gutters'], contact: ['Dale Hart', 'Owner'], roles: ['crew_member'], fields: { coi_expires: '2027-04-30', workers_comp_on_file: false }, scopes: ['gutters'], kinds: ['gutters'] },
  { key: 'northeast_siding', name: 'Northeast Siding Pros (sample subcontractor)', legal: 'Northeast Siding Pros Co. (sample)', types: ['siding_subcontractor'], tags: ['siding'], contact: ['Irene Vance', 'Estimating'], fields: { coi_expires: '2027-02-28', workers_comp_on_file: true }, scopes: ['siding_replacement'], kinds: ['siding'] },
  { key: 'rolloff', name: 'River Valley Roll-Off (sample)', legal: 'River Valley Roll-Off & Disposal (sample)', types: ['haul_off'], tags: [], contact: ['Dispatch desk', 'Dispatch'], fields: { dumpster_sizes: '10, 15 and 20 yard' } },
  { key: 'supply_delivery', name: 'Bay State Supply Delivery (sample)', legal: 'Bay State Building Supply Delivery (sample)', types: ['delivery_partner'], tags: [], contact: ['Yard dispatch', 'Dispatch'], fields: { rooftop_delivery: true } }
];

// ---- Departments --------------------------------------------------------------------------------------------------
type DepartmentSpec = { id: string; label: string; color: string; icon: string; roles: string[]; groupTypes: string[]; people: string[]; companies: string[] };
export const ROOFING_DEPARTMENTS: DepartmentSpec[] = [
  { id: 'leadership', label: 'Leadership', color: '#1f2937', icon: 'fa-briefcase', roles: [], groupTypes: [], people: ['owner', 'gm'], companies: [] },
  { id: 'office', label: 'Office & Admin', color: '#7c3aed', icon: 'fa-building', roles: ['office_manager', 'csr', 'bookkeeper'], groupTypes: [], people: [], companies: [] },
  { id: 'sales', label: 'Sales', color: '#16a34a', icon: 'fa-handshake', roles: ['sales_manager', 'estimator', 'salesperson', 'call_center_rep', 'canvasser'], groupTypes: ['sales_team', 'canvass_team'], people: [], companies: [] },
  { id: 'production', label: 'Production', color: '#2563eb', icon: 'fa-helmet-safety', roles: ['production_manager', 'production_coordinator', 'project_manager'], groupTypes: ['crew'], people: [], companies: ['summit', 'ridgeline', 'valley_gutters', 'northeast_siding', 'rolloff'] },
  { id: 'service', label: 'Service & Repair', color: '#059669', icon: 'fa-screwdriver-wrench', roles: ['repairman'], groupTypes: [], people: [], companies: [] },
  { id: 'warehouse', label: 'Warehouse & Fleet', color: '#64748b', icon: 'fa-warehouse', roles: ['warehouse_lead', 'delivery_driver'], groupTypes: [], people: [], companies: ['supply_delivery'] }
];
/** Department-scoped roles: the sales and production managers manage inside their own departments only. */
const SCOPED = [['derek', 'department_manager', ['sales']], ['alex', 'department_manager', ['production', 'service']]] as const;

// ---- Fields --------------------------------------------------------------------------------------------------------
type FieldSpec = { path: string; label: string; type: string; options?: string[] };
const F: Record<string, FieldSpec> = {
  has_cdl: { path: 'has_cdl', label: 'Has a CDL', type: 'boolean' },
  cdl_class: { path: 'cdl_class', label: 'CDL class', type: 'select', options: ['A', 'B'] },
  cdl_expires: { path: 'cdl_expires', label: 'CDL expires', type: 'date' },
  shirt_size: { path: 'shirt_size', label: 'Shirt size', type: 'select', options: ['S', 'M', 'L', 'XL', '2XL', '3XL'] },
  osha_10: { path: 'osha_10', label: 'OSHA 10 card', type: 'boolean' },
  fall_protection_trained: { path: 'fall_protection_trained', label: 'Fall protection training', type: 'date' },
  csl_number: { path: 'csl_number', label: 'Construction supervisor license', type: 'text' },
  csl_expires: { path: 'csl_expires', label: 'Supervisor license expires', type: 'date' },
  hic_number: { path: 'hic_number', label: 'Home improvement contractor reg.', type: 'text' },
  hic_expires: { path: 'hic_expires', label: 'HIC registration expires', type: 'date' },
  haag_certified: { path: 'haag_certified', label: 'Haag certified inspector', type: 'boolean' },
  drivers_license_expires: { path: 'drivers_license_expires', label: "Driver's license expires", type: 'date' },
  crew_truck: { path: 'crew_truck', label: 'Crew truck', type: 'text' },
  coi_expires: { path: 'coi_expires', label: 'Insurance certificate expires', type: 'date' },
  workers_comp_on_file: { path: 'workers_comp_on_file', label: "Workers' comp certificate on file", type: 'boolean' },
  dumpster_sizes: { path: 'dumpster_sizes', label: 'Dumpster sizes', type: 'text' },
  rooftop_delivery: { path: 'rooftop_delivery', label: 'Rooftop (boom) delivery', type: 'boolean' }
};
/** Which fields each home declares. A path keeps one type everywhere it is declared. */
export const FIELD_HOMES: [kind: 'role' | 'group_type' | 'company_type', id: string, paths: string[]][] = [
  ['role', 'crew_foreman', ['has_cdl', 'cdl_class', 'cdl_expires', 'csl_number', 'csl_expires', 'osha_10', 'fall_protection_trained', 'shirt_size']],
  ['role', 'crew_member', ['has_cdl', 'osha_10', 'fall_protection_trained', 'shirt_size']],
  ['role', 'repairman', ['has_cdl', 'osha_10', 'fall_protection_trained', 'shirt_size']],
  ['role', 'delivery_driver', ['has_cdl', 'cdl_class', 'cdl_expires', 'shirt_size']],
  ['role', 'warehouse_lead', ['has_cdl', 'shirt_size']],
  ['role', 'canvasser', ['shirt_size', 'drivers_license_expires']],
  ['role', 'salesperson', ['hic_number', 'hic_expires', 'drivers_license_expires']],
  ['role', 'sales_manager', ['hic_number', 'hic_expires', 'drivers_license_expires']],
  ['role', 'estimator', ['haag_certified', 'hic_number', 'hic_expires', 'drivers_license_expires']],
  ['role', 'project_manager', ['csl_number', 'csl_expires']],
  ['role', 'production_manager', ['csl_number', 'csl_expires']],
  ['group_type', 'crew', ['crew_truck']],
  ['company_type', 'install_subcontractor', ['coi_expires', 'workers_comp_on_file']], ['company_type', 'gutter_subcontractor', ['coi_expires', 'workers_comp_on_file']],
  ['company_type', 'siding_subcontractor', ['coi_expires', 'workers_comp_on_file']], ['company_type', 'haul_off', ['dumpster_sizes']], ['company_type', 'delivery_partner', ['rooftop_delivery']]
];

// ---- Pay -----------------------------------------------------------------------------------------------------------
export const PAY_SCHEDULES = [
  { id: 'sample_weekly_friday', name: 'Weekly, Fridays (sample)', recurrence: { frequency: 'weekly', weekday: 5 } },
  { id: 'sample_semi_monthly', name: 'Semi-monthly, 15th and last day (sample)', recurrence: { frequency: 'semi_monthly', days: [15, -1], adjust: 'previous_weekday' } },
  { id: 'sample_monthly_commission', name: 'Monthly commissions, 10th (sample)', recurrence: { frequency: 'monthly', day: 10, adjust: 'next_weekday' }, timing_basis: 'completed' }
] as const;
type Pay = { hourly?: number; salary?: number; estimator?: number; booking?: number; sales?: boolean };
/** Pay defaults by role, in whole dollars. Hourly for installers and hourly staff, salary for the office, commission plans for sales. */
export const ROLE_PAY: Record<string, Pay> = {
  crew_member: { hourly: 24 }, repairman: { hourly: 30 }, delivery_driver: { hourly: 26 }, warehouse_lead: { hourly: 27 }, csr: { hourly: 21 },
  call_center_rep: { hourly: 18, booking: 75 }, canvasser: { hourly: 17, booking: 50 }, salesperson: { sales: true },
  estimator: { salary: 60000, estimator: 150 }, sales_manager: { salary: 72000, estimator: 100 },
  office_manager: { salary: 62000 }, bookkeeper: { salary: 56000 }, production_coordinator: { salary: 52000 }, project_manager: { salary: 70000 }, production_manager: { salary: 88000 }
};
/** Personal pay on top of the defaults: leads earn more than the role's rate, and the general manager is salaried. */
const OWN_PAY: Record<string, Pay> = { chris: { hourly: 32 }, mateo: { hourly: 32 }, victor: { hourly: 34 }, tyler: { hourly: 29 }, frank: { hourly: 34 }, gm: { salary: 115000 } };
/** How a group's own earnings (a committed labor list, say) reach its members. */
const GROUP_SPLIT: Record<string, JsonObject> = { crew: { method: 'rule', split_rule_id: 'by_hours_on_the_job' }, sales_team: { method: 'rule', split_rule_id: 'whole_team' } };
const COMPANY_PAY = ['install_subcontractor', 'gutter_subcontractor', 'siding_subcontractor'];

// ---- The run ----------------------------------------------------------------------------------------------------
type Counts = Record<string, number>;
export type PeopleResult = { created: number; updated: number; roles: Counts; groups: Counts; companies: Counts; departments: Counts; fields: Counts; pay: Counts; note?: string };

/** A sandbox organization in the development data environment, or nothing at all. */
async function requireSandbox(orgId: string) {
  if (env.isProduction || env.dataEnvironment !== 'development') throw notFound('not_found', 'Not found.');
  const org = await readOrganization(orgId);
  if (obj(org.metadata).sandbox_test_org !== true) throw forbidden('development_org_required', 'The sample people are only for development sandbox organizations.');
}

function appDefaults(spec: RoleSpec, catalog: AppDefinition[]) {
  const every = (shown: boolean) => Object.fromEntries(deviceTypeIds().map((device) => [device, shown]));
  const defaults: Record<string, JsonObject> = {};
  for (const app of catalog) {
    const shown = (spec.field || []).includes(app.id) || (spec.show || []).includes(app.id);
    const hidden = (spec.hide || []).includes(app.id) || (spec.only === true && app.default_visible && !shown);
    const options = app.id === 'portal.crew_overview' && spec.clock ? { time_clock: true } : {};
    if (shown) defaults[app.id] = { visible: every(true), options, params: obj(spec.params?.[app.id]), layout: {} };
    else if (hidden) defaults[app.id] = { visible: every(false), options: {}, params: {}, layout: {} };
  }
  return defaults;
}

async function seedRoles(orgId: string, counts: Counts) {
  const access = await import('../workforce/access.js');
  const personas = new Map(access.factoryPersonaDefinitions().map((persona) => [persona.id, persona]));
  const { isDepartmentScopeablePermission } = await import('../workforce/department-access.js');
  const catalog = appDefinitions();
  const existing = await access.listAccessRoles(orgId, { include_archived: true });
  const ids = new Map<string, string>();
  for (const spec of ROOFING_ROLES) {
    // Like the seeded roles, every role here may see its own projected earnings.
    let permissions: Record<string, boolean> = { manage_own_notifications: true, 'payroll.view_own_projected_earnings': true };
    for (const base of spec.base || []) Object.assign(permissions, personas.get(base)?.permissions || {});
    for (const key of spec.permissions) permissions[key] = true;
    if (spec.departmentOnly) permissions = Object.fromEntries(Object.entries(permissions).filter(([key, allowed]) => allowed && isDepartmentScopeablePermission(key)));
    const input = { name: spec.name, description: spec.description, permissions, app_defaults: appDefaults(spec, catalog), metadata: { ...metadata, level: spec.level } };
    // Someone's own role of the same name is used as it is; a role this generator made is brought up to date.
    const found = existing.find((role) => role.id === spec.id) || existing.find((role) => role.name.toLowerCase() === spec.name.toLowerCase());
    if (!found) { ids.set(spec.id, (await access.createAccessRole(orgId, { id: spec.id, ...input })).id); counts.created = (counts.created || 0) + 1; continue; }
    ids.set(spec.id, found.id);
    if (!ours(found.metadata)) { counts.reused = (counts.reused || 0) + 1; continue; }
    const normalized = { name: spec.name, description: spec.description, permissions: access.normalizePermissionMap(permissions), app_defaults: access.normalizeAppDefaults(input.app_defaults), metadata: input.metadata, status: 'active' };
    if (unchanged(normalized, found as unknown as JsonObject)) continue;
    await access.patchAccessRole(orgId, found.id, { ...input, status: 'active', expected_revision: found.revision });
    counts.updated = (counts.updated || 0) + 1;
  }
  return (role: string) => ids.get(role) || role;
}

async function seedFieldHomes(orgId: string, roleId: (role: string) => string, counts: Counts, skipped: string[]) {
  const homes = await import('../custom_fields/homes.js');
  const unassigned = new Set(((await homes.unassignedDefinitions(orgId)).fields as JsonObject[]).map((field) => `${text(field.entity)}:${text(field.path)}`));
  for (const [kind, rawId, paths] of FIELD_HOMES) {
    const id = kind === 'role' ? roleId(rawId) : rawId;
    const entity = kind === 'role' ? 'user' : kind === 'group_type' ? 'team' : 'company';
    let wanted = paths.filter((path) => !unassigned.has(`${entity}:${path}`));
    for (const path of paths.filter((entry) => !wanted.includes(entry))) skipped.push(`${path} is an unassigned ${entity} field`);
    for (let attempt = 0; attempt < 6 && wanted.length; attempt += 1) {
      const current = await homes.homeDefinitions(orgId, kind, id);
      const have = new Set((current.fields as JsonObject[]).map((field) => text(field.path)));
      const add = wanted.filter((path) => !have.has(path));
      if (!add.length) break;
      // Every definition the home already has stays as it is; only missing ones are added after them.
      const fields = [...(current.fields as JsonObject[]).map(({ value_schema: _schema, ...field }) => field), ...add.map((path) => ({ ...F[path], entity }))];
      try { await homes.saveHomeDefinitions(orgId, { kind, id, fields, expectedRevision: current.revision }); counts.added = (counts.added || 0) + add.length; break; }
      catch (error) {
        const path = text(obj((error as PlatformError).details).path);
        if (!(error instanceof PlatformError) || !path || !wanted.includes(path)) throw error;
        skipped.push(`${path} on ${kind} ${id}: ${error.message}`);
        wanted = wanted.filter((entry) => entry !== path);
      }
    }
  }
}

async function seedWorkforceConfiguration(orgId: string, roleId: (role: string) => string, counts: Counts) {
  const workforce = await import('../workforce/storage.js');
  const current = await workforce.readWorkforceConfiguration(orgId);
  const has = (rows: unknown[], id: string) => rows.some((row) => text(obj(row).id) === id);
  const tags = ASSIGNMENT_TAGS.filter(([id]) => !has(current.assignment_tags, id)).map(([id, name]) => ({ id, name }));
  const kinds = GROUP_TYPES.filter((type) => !has(current.resource_group_kinds, type.id)).map(({ member_role_ids: _roles, ...type }) => type);
  const companyTypes = COMPANY_TYPES.filter(([id]) => !has(current.organization_connection_types, id)).map(([id, name, description]) => ({ id, name, description }));
  // Existing definitions keep their names; only what is missing is added, and an archived one comes back.
  const revive = (rows: unknown[], ids: string[]) => rows.map(obj).filter((row) => ids.includes(text(row.id)) && row.status === 'archived').map((row) => ({ ...row, status: 'active' }));
  const revived = { kinds: revive(current.resource_group_kinds, GROUP_TYPES.map((type) => type.id)), companies: revive(current.organization_connection_types, COMPANY_TYPES.map(([id]) => id)), tags: revive(current.assignment_tags, ASSIGNMENT_TAGS.map(([id]) => id)) };
  if (tags.length || kinds.length || companyTypes.length || revived.kinds.length || revived.companies.length || revived.tags.length) {
    await workforce.saveWorkforceConfiguration(orgId, { assignment_tags: [...tags, ...revived.tags], resource_group_kinds: [...kinds, ...revived.kinds], organization_connection_types: [...companyTypes, ...revived.companies], expected_revision: current.revision });
    counts.types = kinds.length + companyTypes.length; counts.tags = tags.length;
  }
  // The roles a group type gives on joining. Roles already chosen for a type are kept and only added to.
  const saved = await workforce.readWorkforceConfiguration(orgId);
  for (const type of GROUP_TYPES) {
    const row = obj(saved.resource_group_kinds.find((entry) => text(obj(entry).id) === type.id));
    const next = union(row.member_role_ids, type.member_role_ids.map(roleId));
    if (next.length !== strings(row.member_role_ids).length) await workforce.setResourceGroupKindMemberRoles(orgId, type.id, next);
  }
}


async function seedUsers(orgId: string, roleId: (role: string) => string, result: PeopleResult) {
  const access = await import('../workforce/access.js');
  const roles = await access.listAccessRoles(orgId);
  const known = new Set(roles.map((role) => role.id));
  const users = new Map((await listDocuments(orgId, 'users')).map((doc) => [doc.id, doc]));
  const ids = new Map<string, string>();
  for (const [index, person] of ROOFING_PEOPLE.entries()) {
    const id = stableId(orgId, `person:${person.key}`);
    ids.set(person.key, id);
    const found = users.get(id);
    const data = obj(found?.data);
    // Some actions restamp a user document's own metadata (suspending writes its source there); the data keeps the generator's mark.
    if (found && !ours(found.metadata) && !ours(data.metadata)) { ids.delete(person.key); continue; }
    const accessRoleIds = union(data.access_role_ids, person.roles.map(roleId)).filter((role) => known.has(role));
    const values = { ...obj(person.fields), ...obj(data.custom_field_values) };
    const patch: JsonObject = {
      name: person.name, display_name: person.name, job_title: person.title,
      email: text(data.email) || `${person.key}.${stableId(orgId, person.key).slice(-8)}@example.test`,
      phone: text(data.phone) || phoneOf(index),
      status: text(data.status) || 'active', branch_id: text(data.branch_id) || 'default', account_type: 'employee', role: 'viewer',
      roles: strings(data.roles), access_role_ids: accessRoleIds,
      permissions: obj(data.permissions), permission_overrides: obj(data.permission_overrides), app_access_overrides: obj(data.app_access_overrides),
      worker_classification: person.contractor ? 'independent_contractor' : 'employee',
      assignment_tag_ids: union(data.assignment_tag_ids, person.tags), custom_field_values: values, custom_fields: values,
      metadata: { ...obj(data.metadata), ...metadata }
    };
    if (!found) { await upsertDocument(orgId, 'users', { id, data: { id, ...patch }, metadata }, { createOnly: true }); result.created += 1; }
    else if (!unchanged(patch, data)) { await upsertDocument(orgId, 'users', { id, data: patch, metadata: { ...obj(found.metadata), ...metadata } }, { replace: false }); result.updated += 1; }
  }
  // Earlier sample people (the older sample button's channel members) and a sandbox's own tester get a role, so nobody
  // is left without one. Nothing is taken away from anyone.
  for (const doc of users.values()) {
    const data = obj(doc.data);
    if (strings(data.access_role_ids).length) continue;
    const sample = text(obj(doc.metadata).source) === 'signup_sandbox_samples';
    const tester = text(data.role) === 'owner' && !!text(data.identity_id) && Array.isArray(data.access_role_ids);
    if (!sample && !tester) continue;
    const accessRoleIds = [tester ? 'super_admin' : 'viewer'];
    await upsertDocument(orgId, 'users', { id: doc.id, data: { access_role_ids: accessRoleIds } }, { replace: false });
    result.updated += 1;
  }
  return ids;
}

async function seedGroups(orgId: string, people: Map<string, string>, counts: Counts) {
  const workforce = await import('../workforce/storage.js');
  const { listScopeTemplates } = await import('../scopes/storage.js');
  const scopes = new Set((await listScopeTemplates(orgId, 'default')).map((template) => text(template.id)));
  const existing = await workforce.listResourceGroups(orgId, { include_archived: true });
  // Someone who is suspended stays in their group as an inactive member and does not lead it: a group's active members must be active people.
  const inactive = new Set((await listDocuments(orgId, 'users')).filter((doc) => obj(doc.data).disabled === true || ['disabled', 'deleted'].includes(text(obj(doc.data).status))).map((doc) => doc.id));
  const member = (userId: string, leadId: string | undefined, role = 'member', status = 'active') => {
    const leads = userId === leadId && !inactive.has(userId);
    return { user_id: userId, role: leads ? 'lead' : role === 'lead' ? 'member' : role, is_lead: leads, status: inactive.has(userId) ? 'inactive' : status };
  };
  const ids = new Map<string, string>();
  for (const spec of ROOFING_GROUPS) {
    const id = stableId(orgId, `group:${spec.key}`);
    const found = existing.find((group) => group.id === id) || existing.find((group) => [spec.name, ...spec.formerNames].includes(group.name) && group.status !== 'archived');
    const leadId = people.get(spec.lead);
    const mine = [spec.lead, ...spec.members].map((key) => people.get(key)).filter((user): user is string => !!user);
    if (!found) {
      const created = await workforce.createResourceGroup(orgId, { id, name: spec.name, kind_id: spec.type, assignment_tag_ids: spec.tags, members: mine.map((userId) => member(userId, leadId)), capability_scope_ids: spec.scopes.filter((scope) => scopes.has(scope)), metadata });
      ids.set(spec.key, created.id); counts.created = (counts.created || 0) + 1; continue;
    }
    ids.set(spec.key, found.id);
    // Members someone added by hand stay as they are; the generator's own people are put back, with the lead it names.
    const members = [...mine.map((userId) => member(userId, leadId)), ...found.members.filter((row) => !mine.includes(row.user_id)).map((row) => member(row.user_id, undefined, row.role, row.status))];
    const stored = found.members.map((row) => ({ user_id: row.user_id, role: row.role, is_lead: row.is_lead, status: row.status }));
    const sameMembers = same([...members].sort((a, b) => a.user_id.localeCompare(b.user_id)), [...stored].sort((a, b) => a.user_id.localeCompare(b.user_id)));
    const tags = union(found.assignment_tag_ids, spec.tags), capabilities = union(found.capability_scope_ids, spec.scopes.filter((scope) => scopes.has(scope)));
    if (found.status === 'active' && found.name === spec.name && found.kind_id === spec.type && sameMembers && same(tags, found.assignment_tag_ids) && same(capabilities, found.capability_scope_ids) && ours(found.metadata)) continue;
    // A crew an earlier version gave a kind-of-work type is moved to Crew; what it does is its capabilities.
    await workforce.patchResourceGroup(orgId, found.id, {
      ...(found.status === 'archived' ? { status: 'active' } : {}), name: spec.name, kind_id: spec.type, members,
      assignment_tag_ids: tags, capability_scope_ids: capabilities, metadata, expected_revision: found.revision
    });
    counts.updated = (counts.updated || 0) + 1;
  }
  return ids;
}

async function seedCompanies(orgId: string, roleId: (role: string) => string, actor: PlatformAuthContext, counts: Counts) {
  const connections = await import('../connections/storage.js');
  const base = await import('../assignees/base.js');
  const { listScopeTemplates } = await import('../scopes/storage.js');
  const scopes = new Set((await listScopeTemplates(orgId, 'default')).map((template) => text(template.id)));
  const existing = await connections.listOrganizationConnections(orgId, { include_archived: true, relationship_scope: 'all' });
  const ids = new Map<string, string>();
  for (const [index, spec] of ROOFING_COMPANIES.entries()) {
    const id = stableId(orgId, `company:${spec.key}`);
    const found = existing.find((row) => row.id === id) || existing.find((row) => row.name === spec.name && row.status !== 'archived');
    const contact = { id: 'primary', name: `${spec.contact[0]}`, role: spec.contact[1], email: `${spec.key}.${id.slice(-8)}@example.test`, phone: `(413) 555-01${String(60 + index).padStart(2, '0')}`, primary: true };
    const address = { formatted: `${200 + index * 40} Example Commerce Way, Holyoke, MA 01040 (synthetic)` };
    if (!found) {
      const created = await connections.createOrganizationConnection(orgId, { id, name: spec.name, legal_name: spec.legal, relationship_type_ids: ['work_provider'], contacts: [contact], address, payment_terms: { basis: 'net_days', net_days: 15 }, capability_scope_ids: (spec.scopes || []).filter((scope) => scopes.has(scope)), metadata });
      ids.set(spec.key, String(created.id)); counts.created = (counts.created || 0) + 1;
    } else {
      ids.set(spec.key, String(found.id));
      // A company the sample pay sheets made has only a name: fill in what is missing, keep what is there.
      const capabilityScopes = union(found.capability_scope_ids, (spec.scopes || []).filter((scope) => scopes.has(scope)));
      const patch = {
        ...(found.status === 'archived' ? { status: 'active' } : {}),
        ...(text(found.legal_name) ? {} : { legal_name: spec.legal }), ...(list(found.contacts).length ? {} : { contacts: [contact] }), ...(Object.keys(obj(found.address)).length ? {} : { address }),
        ...(same(capabilityScopes, found.capability_scope_ids) ? {} : { capability_scope_ids: capabilityScopes })
      };
      if (Object.keys(patch).length || !ours(found.metadata)) {
        await connections.patchOrganizationConnection(orgId, String(found.id), { ...patch, metadata, expected_revision: found.revision });
        counts.updated = (counts.updated || 0) + 1;
      }
    }
    const ref = { type: 'organization_connection' as const, id: ids.get(spec.key)! };
    const saved = await base.readAssigneeBase(orgId, ref);
    const types = union(saved.type_ids, spec.types);
    if (types.length !== saved.type_ids.length) await base.writeAssigneeBase(orgId, ref, { type_ids: types }, actor);
    const record = await base.readAssigneeStoreRecord(orgId, ref);
    if (spec.tags.length && union(record?.tag_ids, spec.tags).length !== strings(record?.tag_ids).length) await base.setAssigneeProfile(orgId, { assignee: ref, tag_ids: union(record?.tag_ids, spec.tags) }, actor);
    if (spec.roles?.length && !(await base.readAssigneeBase(orgId, ref)).permission_defaults.access_role_ids.length) await base.setPermissionDefaults(orgId, { assignee: ref, access_role_ids: spec.roles.map(roleId), permission_overrides: {} }, actor);
  }
  return ids;
}

async function seedDepartments(ctx: PlatformAuthContext, roleId: (role: string) => string, people: Map<string, string>, companies: Map<string, string>, retiring: Set<string>, counts: Counts) {
  const departments = await import('../workforce/departments.js');
  const current = await departments.readOrganizationDepartments(ctx.orgId);
  const rows = current.departments.map((row) => ({ ...row }));
  const ids = new Map<string, string>();
  for (const spec of ROOFING_DEPARTMENTS) {
    // An existing department of the same id or name is the same department: it keeps its name, colour and settings and gains members.
    let row = rows.find((entry) => entry.id === spec.id) || rows.find((entry) => entry.label.toLowerCase() === spec.label.toLowerCase());
    // A single-branch company: its departments are in the default branch.
    if (!row) { row = { id: spec.id, label: spec.label, color: spec.color, icon: spec.icon, branch_id: 'default', status: 'active', default_channel: true, app_defaults: {}, subject_keys: [], role_ids: [], group_kind_ids: [] }; rows.push(row); counts.created = (counts.created || 0) + 1; }
    if (!row.icon) row.icon = spec.icon;
    if (row.status === 'archived') row.status = 'active';
    row.role_ids = union(row.role_ids, spec.roles.map(roleId));
    row.group_kind_ids = union(row.group_kind_ids.filter((kind) => !retiring.has(kind)), spec.groupTypes);
    row.subject_keys = union(row.subject_keys, spec.people.map((key) => people.get(key)).filter(Boolean).map((id) => `organization_user:${id}`), spec.companies.map((key) => companies.get(key)).filter(Boolean).map((id) => `organization_connection:${id}`));
    ids.set(spec.id, row.id);
  }
  if (current.revision && same(rows, current.departments)) return ids;
  counts.saved = 1;
  await departments.saveDepartmentSettings(ctx, { departments: rows, terminology: current.terminology, revision: current.revision, legacy_token: current.legacy_token || undefined });
  return ids;
}

/** Declared capabilities: the kinds of work each crew and company does, on top of what its scopes grant. Kinds only grow. */
async function seedCapabilities(orgId: string, groups: Map<string, string>, companies: Map<string, string>, actor: PlatformAuthContext, counts: Counts) {
  const capabilities = await import('../labor/capabilities.js');
  const declared = new Map((await capabilities.listDeclaredCapabilities(orgId)).map((row) => [`${row.assignee.type}:${row.assignee.id}`, row]));
  const targets = [
    ...ROOFING_GROUPS.map((spec) => ({ assignee: { type: 'resource_group' as const, id: groups.get(spec.key) }, kinds: spec.kinds })),
    ...ROOFING_COMPANIES.map((spec) => ({ assignee: { type: 'organization_connection' as const, id: companies.get(spec.key) }, kinds: spec.kinds || [] }))
  ];
  for (const target of targets) {
    if (!target.assignee.id || !target.kinds.length) continue;
    const assignee = { type: target.assignee.type, id: target.assignee.id };
    const current = declared.get(`${assignee.type}:${assignee.id}`);
    const schemaIds = union(current?.schema_ids, target.kinds);
    if (current && same(schemaIds, current.schema_ids)) continue;
    await capabilities.saveCapabilities(orgId, { assignee, schema_ids: schemaIds, item_ids: current?.item_ids || [], excluded_item_ids: current?.excluded_item_ids || [], ...(current ? { expected_revision: current.revision } : {}) }, actor);
    counts.capabilities = (counts.capabilities || 0) + 1;
  }
}

/** Groups an earlier version made that are no longer part of the company: archived, and cleaned up the way archiving one by hand does. */
async function retireGroups(orgId: string, actor: PlatformAuthContext, counts: Counts) {
  const workforce = await import('../workforce/storage.js');
  const base = await import('../assignees/base.js');
  const existing = await workforce.listResourceGroups(orgId, { include_archived: true });
  for (const spec of RETIRED_GROUPS) {
    const id = stableId(orgId, `group:${spec.key}`);
    const found = existing.find((group) => group.id === id) || existing.find((group) => spec.names.includes(group.name) && group.status !== 'archived');
    if (!found || found.status === 'archived' || !ours(found.metadata)) continue;
    await workforce.archiveResourceGroup(orgId, found.id, found.revision);
    await base.cleanupAssignee(orgId, { type: 'resource_group', id: found.id }, actor);
    counts.archived = (counts.archived || 0) + 1;
  }
}

/** The retired types still active, named as this generator named them, that no active group has any more. */
async function retiringGroupTypes(orgId: string) {
  const workforce = await import('../workforce/storage.js');
  const [configuration, groups] = await Promise.all([workforce.readWorkforceConfiguration(orgId), workforce.listResourceGroups(orgId)]);
  return new Set(RETIRED_GROUP_TYPES.filter(([id, name]) => {
    const row = obj(configuration.resource_group_kinds.find((entry) => text(obj(entry).id) === id));
    return text(row.status) === 'active' && text(row.name) === name && !groups.some((group) => group.kind_id === id);
  }).map(([id]) => id));
}

/** Clears what this generator attached to each retiring type (its pay default and its own field definitions), then archives the type. */
async function retireGroupTypes(orgId: string, retiring: Set<string>, actor: { userId: string }, counts: Counts) {
  if (!retiring.size) return;
  const payroll = await import('../payroll/pay-rules.js');
  const homes = await import('../custom_fields/homes.js');
  const workforce = await import('../workforce/storage.js');
  const generatedPaths = new Set(Object.keys(F));
  for (const id of retiring) {
    const pay = await payroll.readPayDefault(orgId, { type: 'group_type', id });
    const generatedPay = pay.revision && pay.entries.every((entry) => entry.note === PAY_NOTE) && (pay.schedules || []).every((entry) => entry.note === PAY_NOTE) && (pay.distribution || []).every((entry) => entry.effective_from === PAY_FROM);
    if (generatedPay && (pay.entries.length || pay.distribution?.length || pay.schedules?.length)) await payroll.savePayDefault(orgId, { subject: { type: 'group_type', id }, entries: [], schedules: [], expected_revision: pay.revision }, actor);
    const fields = await homes.homeDefinitions(orgId, 'group_type', id);
    const kept = (fields.fields as JsonObject[]).filter((field) => !generatedPaths.has(text(field.path)));
    // Left out of the list, a definition is retired and keeps its access rules over any stored value.
    if (kept.length !== fields.fields.length) await homes.saveHomeDefinitions(orgId, { kind: 'group_type', id, fields: kept.map(({ value_schema: _schema, ...field }) => field), expectedRevision: fields.revision });
  }
  const current = await workforce.readWorkforceConfiguration(orgId);
  const archived = current.resource_group_kinds.map(obj).filter((row) => retiring.has(text(row.id))).map(({ member_role_ids: _roles, ...row }) => ({ ...row, status: 'archived' }));
  await workforce.saveWorkforceConfiguration(orgId, { resource_group_kinds: archived, expected_revision: current.revision });
  counts.types_archived = archived.length;
}

async function seedScopedRoles(orgId: string, roleId: (role: string) => string, people: Map<string, string>, departmentIds: Map<string, string>) {
  const access = await import('../workforce/access.js');
  const { validateScopedAccessAssignments } = await import('../workforce/department-access.js');
  const { resolveOrganizationStructure } = await import('../workforce/organization-structure.js');
  const [roles, structure] = await Promise.all([access.listAccessRoles(orgId, { include_archived: true }), resolveOrganizationStructure(orgId)]);
  for (const [key, role, scopes] of SCOPED) {
    const userId = people.get(key);
    if (!userId) continue;
    const doc = await readDocument(orgId, 'users', userId);
    const currentList = list(obj(doc.data).scoped_access_assignments).map(obj);
    const wanted = scopes.map((scope) => ({ role_id: roleId(role), scope: { kind: 'department' as const, id: departmentIds.get(scope)! } }));
    const next = [...currentList, ...wanted.filter((entry) => !currentList.some((row) => row.role_id === entry.role_id && obj(row.scope).id === entry.scope.id))];
    if (next.length === currentList.length) continue;
    await upsertDocument(orgId, 'users', { id: userId, data: { scoped_access_assignments: validateScopedAccessAssignments(next, roles, structure) } }, { replace: false });
  }
}

/** Sample values for team and company fields, for the ones nobody has filled in. */
async function seedSidecarValues(ctx: PlatformAuthContext, groups: Map<string, string>, companies: Map<string, string>, counts: Counts) {
  const records = await import('../custom_fields/records.js');
  const { userPublicationContext } = await import('../platform/publication/context.js');
  const pctx = userPublicationContext(ctx, { mode: 'command' });
  const fill = async (entity: 'team' | 'company', id: string, values: JsonObject) => {
    const target = { scope: 'organization' as const, organizationId: ctx.orgId, id };
    const state = await records.readFieldRecord(pctx, target, entity);
    const stored = records.valuesOf(state.record, entity);
    const declared = new Set(state.fields.map((field) => text(field.path)));
    const missingValues = Object.fromEntries(Object.entries(values).filter(([path, value]) => declared.has(path) && stored[path] === undefined && value !== undefined));
    if (!Object.keys(missingValues).length) return;
    await records.writeFields(pctx, target, entity, { values: missingValues, expectedRevision: state.row?.revision || 0 });
    counts.values = (counts.values || 0) + Object.keys(missingValues).length;
  };
  for (const spec of ROOFING_GROUPS) if (spec.truck && groups.get(spec.key)) await fill('team', groups.get(spec.key)!, { crew_truck: spec.truck });
  for (const spec of ROOFING_COMPANIES) if (companies.get(spec.key)) await fill('company', companies.get(spec.key)!, spec.fields);
}

async function seedPay(orgId: string, roleId: (role: string) => string, people: Map<string, string>, actor: { userId: string }, counts: Counts) {
  const payroll = await import('../payroll/pay-rules.js');
  const storage = await import('../payroll/storage.js');
  const { payrollScheduleInputSchema } = await import('../payroll/schemas.js');
  await (await import('../payroll/sample-pay-rules.js')).seedSamplePayRules(orgId, actor);
  for (const schedule of PAY_SCHEDULES) {
    if (await missing(() => storage.readPayrollSchedule(orgId, schedule.id))) continue;
    await storage.createPayrollSchedule(orgId, { id: schedule.id, ...payrollScheduleInputSchema.parse({ name: schedule.name, timezone: 'America/New_York', recurrence: schedule.recurrence, ...('timing_basis' in schedule ? { timing_basis: schedule.timing_basis } : {}), metadata }) } as never);
    counts.schedules = (counts.schedules || 0) + 1;
  }
  const from = PAY_FROM;
  const span = { effective_from: from, note: PAY_NOTE };
  const entriesFor = (pay: Pay) => [
    ...(pay.hourly ? [{ kind: 'plan', plan_id: 'hourly_staff', ...span }, { kind: 'override', rule_id: 'hourly_time_clock', params: { rate_cents: pay.hourly * 100 }, ...span }] : []),
    ...(pay.salary ? [{ kind: 'plan', plan_id: 'salaried', ...span }, { kind: 'override', rule_id: 'salary', params: { annual_cents: pay.salary * 100 }, ...span }] : []),
    ...(pay.sales || pay.estimator ? [{ kind: 'plan', plan_id: 'estimator', ...span }] : []),
    ...(pay.estimator ? ['estimator_commission_sold', 'estimator_commission_completed'].map((rule) => ({ kind: 'override', rule_id: rule, params: { rate_bps: pay.estimator }, ...span })) : []),
    ...(pay.booking ? [{ kind: 'plan', plan_id: 'inside_sales', ...span }, { kind: 'override', rule_id: 'inside_sales_booking', params: { amount_cents: pay.booking * 100 }, ...span }] : [])
  ];
  const schedulesFor = (pay: Pay) => [
    { effective_from: from, earning_kind: '*', schedule_id: pay.salary ? 'sample_semi_monthly' : 'sample_weekly_friday', note: PAY_NOTE },
    ...(pay.sales || pay.estimator || pay.booking ? [{ effective_from: from, earning_kind: 'commission', schedule_id: 'sample_monthly_commission', note: PAY_NOTE }] : [])
  ];
  // Written by this generator when every entry and schedule choice carries its note and every distribution setting
  // starts on its date. Anything someone changed is theirs and is left alone.
  const mine = (row: { entries: { note?: string }[]; distribution?: { effective_from: string }[]; schedules?: { note?: string }[]; revision: number }) => !row.revision
    || (row.entries.every((entry) => entry.note === PAY_NOTE) && (row.schedules || []).every((entry) => entry.note === PAY_NOTE) && (row.distribution || []).every((entry) => entry.effective_from === from));
  const stored = (row: JsonObject) => ({ entries: list(row.entries).map(obj).map(({ entered_at: _at, entered_by: _by, ...entry }) => entry), distribution: list(row.distribution), schedules: list(row.schedules).map(obj).map(({ entered_at: _at, entered_by: _by, ...entry }) => entry) });
  const saveDefault = async (subject: { type: 'role' | 'group_type' | 'company_type'; id: string }, input: JsonObject) => {
    const current = await payroll.readPayDefault(orgId, subject);
    if (!mine(current)) { counts.kept = (counts.kept || 0) + 1; return; }
    const next = { subject, ...input, expected_revision: current.revision };
    if (current.revision && same(stored((await payroll.draftPayDefault(orgId, next, actor)).data), stored(current))) return;
    await payroll.savePayDefault(orgId, next, actor);
    counts.defaults = (counts.defaults || 0) + 1;
  };
  for (const [role, pay] of Object.entries(ROLE_PAY)) await saveDefault({ type: 'role', id: roleId(role) }, { entries: entriesFor(pay), schedules: schedulesFor(pay) });
  for (const [type, split] of Object.entries(GROUP_SPLIT)) await saveDefault({ type: 'group_type', id: type }, { entries: [], distribution: [{ effective_from: from, mode: 'split', ...split }] });
  for (const type of COMPANY_PAY) await saveDefault({ type: 'company_type', id: type }, { entries: [{ kind: 'plan', plan_id: 'labor_by_commitment', ...span }], schedules: [{ effective_from: from, earning_kind: '*', schedule_id: 'sample_weekly_friday', note: PAY_NOTE }] });
  for (const [key, pay] of Object.entries(OWN_PAY)) {
    const userId = people.get(key);
    if (!userId) continue;
    const payee = { type: 'organization_user' as const, id: userId };
    const current = await payroll.readPaySetup(orgId, payee);
    if (!mine(current)) { counts.kept = (counts.kept || 0) + 1; continue; }
    // A lead keeps the role's plan and only has a higher rate of their own; the general manager is paid a salary.
    const entries = pay.salary ? entriesFor(pay) : [{ kind: 'override', rule_id: 'hourly_time_clock', params: { rate_cents: pay.hourly! * 100 }, ...span }];
    const next = { payee, entries, ...(pay.salary ? { schedules: schedulesFor(pay) } : {}), expected_revision: current.revision };
    if (current.revision && same(stored(await payroll.normalizePaySetup(orgId, next, actor, current)), stored(current))) continue;
    await payroll.savePaySetup(orgId, next, actor);
    counts.setups = (counts.setups || 0) + 1;
  }
}

/**
 * Builds or refreshes the roofing company's people in a development sandbox. `ctx` acts for the owner: it must be
 * allowed to manage users and their permissions. Returns counts by part; `note` lists anything that was skipped.
 */
export async function seedRoofingPeople(ctx: PlatformAuthContext): Promise<PeopleResult> {
  const orgId = ctx.orgId;
  await requireSandbox(orgId);
  for (const permission of ['manage_company_settings', 'manage_company_users', 'manage_company_user_permissions']) {
    if (!hasPermission(ctx, permission)) throw forbidden('permission_denied', `You need ${permission} access to generate the sample people.`);
  }
  const result: PeopleResult = { created: 0, updated: 0, roles: {}, groups: {}, companies: {}, departments: {}, fields: {}, pay: {} };
  const skipped: string[] = [];
  const roleId = await seedRoles(orgId, result.roles);
  await seedWorkforceConfiguration(orgId, roleId, result.groups);
  await seedFieldHomes(orgId, roleId, result.fields, skipped);
  const people = await seedUsers(orgId, roleId, result);
  if (people.size < ROOFING_PEOPLE.length) skipped.push(`${ROOFING_PEOPLE.length - people.size} sample ids belong to records the generator did not make`);
  const groups = await seedGroups(orgId, people, result.groups);
  for (const spec of ROOFING_GROUPS) {
    const groupId = groups.get(spec.key);
    if (!groupId || !spec.staffing.length) continue;
    const ref = { type: 'resource_group' as const, id: groupId };
    const saved = await (await import('../assignees/base.js')).readAssigneeBase(orgId, ref);
    const staffing = [...saved.staffing_requirements, ...spec.staffing.filter((entry) => !saved.staffing_requirements.some((row) => row.id === entry.id))];
    if (staffing.length !== saved.staffing_requirements.length) await (await import('../assignees/base.js')).setGroupStaffingRequirements(orgId, { assignee: ref, staffing_requirements: staffing }, ctx);
  }
  const companies = await seedCompanies(orgId, roleId, ctx, result.companies);
  await seedCapabilities(orgId, groups, companies, ctx, result.groups);
  await retireGroups(orgId, ctx, result.groups);
  const retiring = await retiringGroupTypes(orgId);
  const departments = await seedDepartments(ctx, roleId, people, companies, retiring, result.departments);
  await seedScopedRoles(orgId, roleId, people, departments);
  await seedSidecarValues(ctx, groups, companies, result.fields);
  await seedPay(orgId, roleId, people, { userId: ctx.userId }, result.pay);
  await retireGroupTypes(orgId, retiring, { userId: ctx.userId }, result.groups);
  if (skipped.length) result.note = `Skipped: ${skipped.join('; ')}`;
  return result;
}
