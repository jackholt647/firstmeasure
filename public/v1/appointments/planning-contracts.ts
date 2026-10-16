import {departmentSchema} from '../workforce/department-contracts.js';
import {z} from 'zod';
const id=z.string().trim().min(1).max(120);
const ids=z.array(id).max(200);
export const staffingSchema=z.object({department_id:id.optional(),subject_type:z.enum(['any','organization_user','resource_group']).default('any'),mode:z.enum(['count','all','percent','specific']).default('count'),count:z.number().int().min(1).max(100).default(1),percent:z.number().min(1).max(100).default(100),subject_keys:ids.default([]),crew_member_percent:z.number().min(0).max(100).default(0)}).strict();
export const appointmentConfigurationSchema=z.object({
  title:z.string().trim().min(1).max(200).default('Appointment'),preset_id:id.optional(),department_ids:ids.default([]),delivery:z.boolean().default(false),
  // The event type a booking carries (docs/architecture/crm.md, "Appointment setting"): a sales preset names sales_appointment so its bookings advance sales scopes.
  event_type_id:id.optional(),
  timing_mode:z.enum(['timed','days']).default('timed'),duration_days:z.number().int().min(1).max(31).default(2),
  location:z.object({mode:z.enum(['project','company_office','custom','none']).default('project'),address:z.string().trim().max(1000).default('')}).strict().default({mode:'project',address:''}),
  duration_minutes:z.number().int().min(5).max(1440).default(60),window_minutes:z.number().int().min(5).max(1440).default(60),slot_minutes:z.number().int().min(5).max(240).default(30),
  requirements:z.array(staffingSchema).max(12).default([]),
  recurrence:z.object({frequency:z.enum(['daily','weekly','monthly','quarterly','yearly']),interval:z.number().int().min(1).max(52).default(1),occurrence_count:z.number().int().min(2).max(52).default(8)}).strict().nullable().default(null)
}).strict().refine(v=>v.timing_mode==='days'||v.window_minutes>=v.duration_minutes,{message:'Arrival window must be at least the appointment duration.',path:['window_minutes']});
export type AppointmentConfiguration=z.infer<typeof appointmentConfigurationSchema>;

// Departments are the organization's (docs/architecture/branches.md). A copy saved with the older category and unit fields reads without them.
const catalogDepartmentSchema=z.preprocess(value=>{if(!value||typeof value!=='object'||Array.isArray(value))return value;const {group_id:_group,division_id:_division,...rest}=value as Record<string,unknown>;return rest;},departmentSchema);
// `groups` held department categories, which no longer exist: it is accepted and always empty.
export const appointmentCatalogSchema=z.object({departments:z.array(catalogDepartmentSchema).max(500),groups:z.array(z.object({id,label:z.string().trim().min(1).max(100)}).strict()).max(100).transform(()=>[] as Array<{id:string;label:string}>).default([]),presets:z.array(z.object({id,label:z.string().trim().min(1).max(100),configuration:appointmentConfigurationSchema}).strict()).max(200)}).strict();
export const previewSchema=z.object({project_id:id.optional(),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),configuration:appointmentConfigurationSchema}).strict();
export const plannedBookingSchema=z.object({project_id:id.optional(),event_id:z.string().regex(/^appointment_[a-zA-Z0-9-]{16,80}$/),start_at:z.string().datetime({offset:true}),configuration:appointmentConfigurationSchema}).strict();


/**
 * A branch's appointment catalog offers only that branch's departments (docs/architecture/branches.md). A department
 * always has a branch_id in the current model; one without it is treated as belonging to every branch.
 */
export function departmentInBranch(department:{branch_id?:string},branchId:string){
  return !department.branch_id||department.branch_id===(branchId||'default');
}
type CatalogPreset=z.infer<typeof appointmentCatalogSchema>['presets'][number];
/** Drops, without failing, what a stored preset names of another branch's departments: those department ids and those staffing requirements. */
export function presetsForBranch(presets:CatalogPreset[],departments:Array<{id:string;branch_id?:string}>,branchId:string):CatalogPreset[]{
  const elsewhere=new Set(departments.filter(d=>!departmentInBranch(d,branchId)).map(d=>d.id));
  return presets.map(p=>({...p,configuration:{...p.configuration,department_ids:p.configuration.department_ids.filter(id=>!elsewhere.has(id)),requirements:p.configuration.requirements.filter(r=>!r.department_id||!elsewhere.has(r.department_id))}}));
}
/** The department ids of other branches a catalog being saved names, in its departments or its presets. Empty when it is all this branch's. */
export function otherBranchDepartmentIds(catalog:z.infer<typeof appointmentCatalogSchema>,departments:Array<{id:string;branch_id?:string}>,branchId:string){
  const elsewhere=new Set(departments.filter(d=>!departmentInBranch(d,branchId)).map(d=>d.id));
  return [...new Set([...catalog.departments.map(d=>d.id),...catalog.presets.flatMap(p=>[...p.configuration.department_ids,...p.configuration.requirements.map(r=>r.department_id||'')])].filter(id=>elsewhere.has(id)))];
}
