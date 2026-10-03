import {z} from 'zod';
const id=z.string().trim().min(1).max(120);
const ids=z.array(id).max(200);
export const staffingSchema=z.object({department_id:id.optional(),subject_type:z.enum(['any','organization_user','resource_group']).default('any'),mode:z.enum(['count','all','percent','specific']).default('count'),count:z.number().int().min(1).max(100).default(1),percent:z.number().min(1).max(100).default(100),subject_keys:ids.default([]),crew_member_percent:z.number().min(0).max(100).default(0)}).strict();
export const appointmentConfigurationSchema=z.object({
  title:z.string().trim().min(1).max(200).default('Appointment'),preset_id:id.optional(),department_ids:ids.default([]),delivery:z.boolean().default(false),
  timing_mode:z.enum(['timed','days']).default('timed'),duration_days:z.number().int().min(1).max(31).default(2),
  location:z.object({mode:z.enum(['project','company_office','custom','none']).default('project'),address:z.string().trim().max(1000).default('')}).strict().default({mode:'project',address:''}),
  duration_minutes:z.number().int().min(5).max(1440).default(60),window_minutes:z.number().int().min(5).max(1440).default(60),slot_minutes:z.number().int().min(5).max(240).default(30),
  requirements:z.array(staffingSchema).max(12).default([]),
  recurrence:z.object({frequency:z.enum(['daily','weekly','monthly','quarterly','yearly']),interval:z.number().int().min(1).max(52).default(1),occurrence_count:z.number().int().min(2).max(52).default(8)}).strict().nullable().default(null)
}).strict().refine(v=>v.timing_mode==='days'||v.window_minutes>=v.duration_minutes,{message:'Arrival window must be at least the appointment duration.',path:['window_minutes']});
export type AppointmentConfiguration=z.infer<typeof appointmentConfigurationSchema>;
const departmentSchema=z.object({id,label:z.string().trim().min(1).max(100),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),group_id:z.string().max(120).default(''),subject_keys:ids.default([]),role_ids:ids.default([]),group_kind_ids:ids.default([])}).strict();
export const appointmentCatalogSchema=z.object({departments:z.array(departmentSchema).max(200),groups:z.array(z.object({id,label:z.string().trim().min(1).max(100)}).strict()).max(100).default([]),presets:z.array(z.object({id,label:z.string().trim().min(1).max(100),configuration:appointmentConfigurationSchema}).strict()).max(200)}).strict();
export const previewSchema=z.object({project_id:id.optional(),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),configuration:appointmentConfigurationSchema}).strict();
export const plannedBookingSchema=z.object({project_id:id.optional(),event_id:z.string().regex(/^appointment_[a-zA-Z0-9-]{16,80}$/),start_at:z.string().datetime({offset:true}),configuration:appointmentConfigurationSchema}).strict();

