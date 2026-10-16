import {z} from 'zod';
/**
 * The organization's structure: organization -> (optional) regions -> branches -> departments.
 * See docs/architecture/branches.md. A branch is the organization's settings scope (a `branch` document, `default`
 * when there is only one). A department belongs to exactly one branch. A region only groups branches; it is flat and
 * holds no departments. There are no department categories.
 */
const id=z.string().trim().min(1).max(120);
const ids=z.array(id).max(200);
const status=z.enum(['active','archived']).default('active');
export const DEFAULT_BRANCH_ID='default';
// One app's setting for a department (docs/architecture/app-experience.md): device type -> shown, option -> on; a restricted app is hidden everywhere and refused by the server.
export const departmentAppDefaultSchema=z.object({visible:z.record(z.boolean()).optional(),options:z.record(z.boolean()).optional(),restricted:z.boolean().default(false),params:z.record(z.unknown()).optional(),layout:z.record(z.unknown()).optional()}).strict();
/** A region groups branches for sorting, filtering and access scope. Flat: a region never contains another region. */
export const regionSchema=z.object({id,label:z.string().trim().min(1).max(100),status,branch_ids:ids.default([])}).strict();
// An icon is stored the way scope templates and equipment types store theirs: a Font Awesome class name such as
// "fa-helmet-safety", optionally with a style class before it ("fa-solid fa-truck"). Empty means no icon.
export const departmentIconSchema=z.string().trim().max(80).regex(/^(fa-[a-z0-9-]+( fa-[a-z0-9-]+)*)?$/,'Use a Font Awesome class name such as fa-helmet-safety.');
export const departmentSchema=z.object({id,label:z.string().trim().min(1).max(100),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),icon:departmentIconSchema.optional(),branch_id:id.default(DEFAULT_BRANCH_ID),status,default_channel:z.boolean().default(true),app_defaults:z.record(id,departmentAppDefaultSchema).default({}),subject_keys:ids.default([]),role_ids:ids.default([]),group_kind_ids:ids.default([])}).strict();
/** A scope an older organizational unit's grants now apply to. */
export const migratedScopeSchema=z.object({kind:z.enum(['branch','region']),id}).strict();
/** Written once, when a catalog that still had units is first saved: what each unit's scoped grants now cover. Read only. */
export const unitMigrationSchema=z.object({scopes:z.record(id,z.array(migratedScopeSchema).max(200)).default({}),dropped_unit_ids:ids.max(500).default([])}).strict();
const terminologySchema=z.object({department:z.object({singular:z.string().trim().min(1).max(80),plural:z.string().trim().min(1).max(80)}).strict().default({singular:'Department',plural:'Departments'})}).strict().default({});
export const departmentCatalogSchema=z.object({departments:z.array(departmentSchema).max(500),regions:z.array(regionSchema).max(200).default([]),terminology:terminologySchema,unit_migration:unitMigrationSchema.optional()}).strict();
/** A department save. Regions are changed with the branch structure actions and are kept as they are. */
const departmentInputSchema=departmentSchema.extend({branch_id:id.optional()}).strict();
export const departmentSaveSchema=z.object({departments:z.array(departmentInputSchema).max(500),terminology:terminologySchema.optional(),revision:z.number().int().nonnegative(),legacy_token:z.string().optional()}).strict();
export const departmentAssignmentSchema=z.object({kind:z.enum(['user','role','group','group_kind','connection']),id:z.string().min(1).max(180),department_ids:ids,revision:z.number().int().nonnegative(),legacy_token:z.string().optional()}).strict();
export type DepartmentCatalog=z.infer<typeof departmentCatalogSchema>;
export type Region=z.infer<typeof regionSchema>;
export type MigratedScope=z.infer<typeof migratedScopeSchema>;

type LegacyUnit={id:string;label:string;parent_id:string;branch_id:string;status:string};
const text=(value:unknown)=>String(value??'').trim();
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** True when a stored catalog still has organizational units or department categories. */
export function isLegacyCatalog(raw:unknown){
  const data=record(raw);
  return Array.isArray(data.divisions)||Array.isArray(data.groups)||(Array.isArray(data.departments)&&data.departments.some(row=>'division_id' in record(row)||'group_id' in record(row)));
}

/**
 * Reads a catalog stored before branches owned departments, without writing. Pure.
 *
 * - Department categories (`groups`, `group_id`) are dropped.
 * - A department moves to the branch of its unit, or of the nearest unit above it that names a branch; otherwise to the
 *   default branch.
 * - A unit that is a grouping of branches (it has units below it that name branches, or it names no branch itself but
 *   units below it do) becomes a flat region with the same id. Each branch goes to its nearest grouping unit.
 * - A unit that only stands for one branch (it names a branch and no unit below it names another) is that branch: its
 *   grants become branch grants.
 * - A unit that names no branch, directly or below it, is dropped with its grants.
 * - Direct affiliations to units (`subject_keys`) are dropped: membership is now branch membership.
 *
 * `knownBranchIds` limits branch references to branches that exist; `default` always does.
 */
export function migrateLegacyCatalog(raw:unknown,knownBranchIds?:Iterable<string>):DepartmentCatalog{
  const data=record(raw);
  const known=knownBranchIds?new Set([DEFAULT_BRANCH_ID,...knownBranchIds]):null;
  const units:LegacyUnit[]=(Array.isArray(data.divisions)?data.divisions:[]).map(record).map(row=>({id:text(row.id),label:text(row.label)||text(row.id),parent_id:text(row.parent_id),branch_id:text(row.branch_id),status:text(row.status)||'active'})).filter(row=>row.id);
  const byId=new Map(units.map(unit=>[unit.id,unit]));
  const activeChain=(unitId:string)=>{const chain:LegacyUnit[]=[];let current=byId.get(unitId);while(current){if(current.status==='archived'||chain.includes(current))return [];chain.push(current);current=current.parent_id?byId.get(current.parent_id):undefined;if(chain.length>500)return [];}return chain;};
  const validBranch=(branchId:string)=>!!branchId&&(!known||known.has(branchId));
  const active=units.filter(unit=>activeChain(unit.id).length);
  const below=(unit:LegacyUnit)=>active.filter(other=>other!==unit&&activeChain(other.id).slice(1).includes(unit));
  const covered=(unit:LegacyUnit)=>[...new Set([unit,...below(unit)].map(row=>row.branch_id).filter(validBranch))];
  const isBranchUnit=(unit:LegacyUnit)=>validBranch(unit.branch_id)&&covered(unit).every(branchId=>branchId===unit.branch_id);
  const groupings=active.filter(unit=>covered(unit).length&&!isBranchUnit(unit));
  // Each branch belongs to its nearest grouping unit, found from the unit that names it (or the grouping itself).
  const regionOfBranch=new Map<string,string>();
  for(const unit of active){
    if(!validBranch(unit.branch_id)||regionOfBranch.has(unit.branch_id))continue;
    const grouping=activeChain(unit.id).find(row=>groupings.includes(row));
    if(grouping)regionOfBranch.set(unit.branch_id,grouping.id);
  }
  const regions=groupings.map(unit=>({id:unit.id,label:unit.label.slice(0,100),status:'active' as const,branch_ids:[...regionOfBranch].filter(([,regionId])=>regionId===unit.id).map(([branchId])=>branchId).sort()})).filter(region=>region.branch_ids.length);
  const regionIds=new Set(regions.map(region=>region.id));
  const scopes:Record<string,MigratedScope[]>={};
  for(const unit of active){
    if(isBranchUnit(unit)){scopes[unit.id]=[{kind:'branch',id:unit.branch_id}];continue;}
    const covering=[...new Set(covered(unit).map(branchId=>regionOfBranch.get(branchId)||''))].filter(regionId=>regionIds.has(regionId)).sort();
    if(covering.length)scopes[unit.id]=covering.map(regionId=>({kind:'region',id:regionId}));
  }
  const unitBranch=(unitId:string)=>activeChain(unitId).find(unit=>validBranch(unit.branch_id))?.branch_id||DEFAULT_BRANCH_ID;
  const departments=(Array.isArray(data.departments)?data.departments:[]).map(record).map(row=>{
    const {group_id:_group,division_id:division,...rest}=row;
    return {...rest,branch_id:validBranch(text(rest.branch_id))?text(rest.branch_id):unitBranch(text(division))};
  });
  return departmentCatalogSchema.parse({
    departments,regions,...(data.terminology?{terminology:data.terminology}:{}),
    unit_migration:{scopes,dropped_unit_ids:units.map(unit=>unit.id).filter(unitId=>!scopes[unitId]).sort()}
  });
}
