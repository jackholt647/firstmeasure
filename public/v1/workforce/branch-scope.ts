import {hasPermission,type PlatformAuthContext} from '../platform/auth.js';
import {forbidden} from '../platform/errors.js';
import {DEFAULT_BRANCH_ID} from './department-contracts.js';

/**
 * Who may see and manage which branches. See docs/architecture/branches.md.
 *
 * Branch scope applies only when the organization has the multiple-branches feature and more than one active branch.
 * Otherwise nothing is restricted and nothing about branches is shown. When it applies, a person sees and manages the
 * branches they belong to; `view_region_branches` / `manage_region_branches` add the other branches of the regions
 * their branches are in, and `view_all_branches` / `manage_all_branches` add every branch. Managing implies seeing.
 * Scope never grants anything by itself: the ordinary permission for the record (manage_company_users and so on) is
 * still required.
 */
export const BRANCH_FEATURE='platform.multiple_branches';
export const BRANCH_PERMISSIONS=Object.freeze({view_region:'view_region_branches',manage_region:'manage_region_branches',view_all:'view_all_branches',manage_all:'manage_all_branches'});
export type BranchReach='own'|'region'|'all';
export type BranchScope={
  /** The organization has the multiple-branches feature. */
  enabled:boolean;
  /** The feature is on and there is more than one active branch: branch structure is shown and scope applies. */
  multiple:boolean;
  my_branch_id:string;
  own_branch_ids:string[];
  my_region_ids:string[];
  /** Own branches plus the other branches of the regions they are in. */
  region_branch_ids:string[];
  see:BranchReach;
  manage:BranchReach;
  restricted_view:boolean;
  restricted_manage:boolean;
  /** Every branch id when not restricted. */
  visible_branch_ids:string[];
  manageable_branch_ids:string[];
};
type StructureLike={branches?:Array<{id:string;status?:string}>;catalog?:{regions?:Array<{id:string;status?:string;branch_ids?:string[]}>};users?:Array<{id:string;branch_ids?:string[]}>};
const text=(value:unknown)=>String(value??'').trim();
const unique=(values:unknown[])=>[...new Set(values.map(text).filter(Boolean))];
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

export function multipleBranchesEnabled(ctx:Pick<PlatformAuthContext,'capabilities'>){
  return ctx.capabilities?.effectiveByKey?.[BRANCH_FEATURE]===true;
}
/** The branches a user document belongs to: its `branch_id` (their own branch, which picks their settings) and `branch_ids`. */
export function userBranchIds(data:unknown){
  const user=record(data);
  return unique([text(user.branch_id)||DEFAULT_BRANCH_ID,...(Array.isArray(user.branch_ids)?user.branch_ids:[])]);
}

export function branchScope(ctx:PlatformAuthContext):BranchScope{
  const structure=ctx.organizationStructure as StructureLike|undefined;
  const all=unique([DEFAULT_BRANCH_ID,...(structure?.branches||[]).map(b=>b.id)]);
  const active=unique([...(structure?.branches||[]).filter(b=>b.status!=='archived').map(b=>b.id)]);
  const enabled=multipleBranchesEnabled(ctx);
  const multiple=enabled&&active.length>1;
  const my_branch_id=text(ctx.user?.branch_id)||text(ctx.branchId)||DEFAULT_BRANCH_ID;
  const own=unique([my_branch_id,...userBranchIds(ctx.user)]);
  const regions=(structure?.catalog?.regions||[]).filter(r=>r.status!=='archived');
  const my_region_ids=regions.filter(r=>(r.branch_ids||[]).some(id=>own.includes(id))).map(r=>r.id).sort();
  const regionBranches=unique(regions.filter(r=>my_region_ids.includes(r.id)).flatMap(r=>r.branch_ids||[]));
  const can=(key:string)=>hasPermission(ctx,key);
  const manage:BranchReach=can(BRANCH_PERMISSIONS.manage_all)?'all':can(BRANCH_PERMISSIONS.manage_region)?'region':'own';
  const see:BranchReach=manage==='all'||can(BRANCH_PERMISSIONS.view_all)?'all':manage==='region'||can(BRANCH_PERMISSIONS.view_region)?'region':'own';
  const reach=(level:BranchReach)=>level==='all'?all:unique([...own,...(level==='region'?regionBranches:[])]);
  return {
    enabled,multiple,my_branch_id,own_branch_ids:own,my_region_ids,region_branch_ids:unique([...own,...regionBranches]),see,manage,
    restricted_view:multiple&&see!=='all',restricted_manage:multiple&&manage!=='all',
    visible_branch_ids:multiple?reach(see):all,manageable_branch_ids:multiple?reach(manage):all
  };
}

/** A record in these branches is visible. `everyWhenEmpty`: an empty list means every branch (an outside company). */
export function canSeeBranches(scope:BranchScope,branchIds:string[],everyWhenEmpty=false){
  if(!scope.restricted_view)return true;
  if(!branchIds.length)return everyWhenEmpty;
  return branchIds.some(id=>scope.visible_branch_ids.includes(id));
}
export function canManageBranches(scope:BranchScope,branchIds:string[],everyWhenEmpty=false){
  if(!scope.restricted_manage)return true;
  if(!branchIds.length)return everyWhenEmpty;
  return branchIds.some(id=>scope.manageable_branch_ids.includes(id));
}
export function assertSeeBranches(scope:BranchScope,branchIds:string[],everyWhenEmpty=false){
  if(!canSeeBranches(scope,branchIds,everyWhenEmpty))throw forbidden('branch_scope_denied','This record belongs to a branch you cannot see.');
}
export function assertManageBranches(scope:BranchScope,branchIds:string[],everyWhenEmpty=false){
  if(!canManageBranches(scope,branchIds,everyWhenEmpty))throw forbidden('branch_scope_denied','This record belongs to a branch you cannot manage.');
}
/**
 * A change of a record's branches. The record must be manageable now, and every branch added or removed must be
 * manageable. An outside company's empty list (every branch) can be set or cleared only by someone who manages every branch.
 */
export function assertBranchChange(scope:BranchScope,before:string[],after:string[],everyWhenEmpty=false){
  if(!scope.restricted_manage)return;
  if(everyWhenEmpty&&(!before.length||!after.length))throw forbidden('branch_scope_denied','Only someone who manages every branch can change a company that works in every branch, or make one.');
  assertManageBranches(scope,before);
  const changed=[...before.filter(id=>!after.includes(id)),...after.filter(id=>!before.includes(id))];
  if(changed.some(id=>!scope.manageable_branch_ids.includes(id)))throw forbidden('branch_scope_denied','You can only add or remove branches you manage.');
}
/**
 * The branch filter a list was asked for, as branch ids, never wider than what the viewer may see. `branch_ids` is
 * `mine`, `region`, `all` or a comma-separated list of branch ids, and the words can be combined with ids. Null means
 * no filter was asked for and the viewer is not restricted: list everything.
 */
export function requestedBranchIds(scope:BranchScope,query:unknown):string[]|null{
  const raw=record(query).branch_ids;
  const values=unique(Array.isArray(raw)?raw:text(raw).split(','));
  if(!values.length)return scope.restricted_view?scope.visible_branch_ids:null;
  const requested=unique(values.flatMap(value=>value==='all'?scope.visible_branch_ids:value==='mine'?scope.own_branch_ids:value==='region'?scope.region_branch_ids:[value]));
  return requested.filter(id=>scope.visible_branch_ids.includes(id));
}

/** The branches a department, branch or region scope covers, for checking that someone may give a grant there. */
export function grantScopeBranchIds(structure:{catalog:{departments:Array<{id:string;branch_id?:string}>;regions?:Array<{id:string;branch_ids?:string[]}>}},scope:{kind:string;id:string}){
  if(scope.kind==='branch')return [scope.id];
  if(scope.kind==='region')return unique((structure.catalog.regions||[]).find(r=>r.id===scope.id)?.branch_ids||[]);
  return unique([structure.catalog.departments.find(d=>d.id===scope.id)?.branch_id||DEFAULT_BRANCH_ID]);
}
/** A restricted administrator gives scoped roles only inside branches they manage; a region needs every branch in it. */
export function assertGrantScopesManageable(ctx:PlatformAuthContext,structure:Parameters<typeof grantScopeBranchIds>[0],scopes:Array<{kind:string;id:string}>){
  const scope=branchScope(ctx);
  if(!scope.restricted_manage)return;
  if(scopes.some(entry=>grantScopeBranchIds(structure,entry).some(id=>!scope.manageable_branch_ids.includes(id))))throw forbidden('branch_scope_denied','You can only give scoped roles in branches you manage.');
}
