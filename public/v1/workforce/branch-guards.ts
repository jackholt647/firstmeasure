import type {PlatformAuthContext} from '../platform/auth.js';
import {forbidden} from '../platform/errors.js';
import {readDocument} from '../platform/storage.js';
import {DEFAULT_BRANCH_ID} from './department-contracts.js';
import {assertBranchChange,assertManageBranches,assertSeeBranches,branchScope,canSeeBranches,requestedBranchIds,userBranchIds} from './branch-scope.js';

/**
 * Branch scope on the People data routes: the users list, groups and outside companies. See docs/architecture/branches.md.
 * Each list keeps what the viewer may see (and, with `branch_ids`, what they asked for); each write needs the record to
 * be in a branch the writer manages. Nothing changes for an organization with one branch.
 */
type Row={branch_id?:unknown;branch_ids?:unknown;data?:unknown;id?:unknown};
const text=(value:unknown)=>String(value??'').trim();
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const list=(value:unknown)=>Array.isArray(value)?value.map(text).filter(Boolean):[];
const groupBranches=(row:Row)=>{const ids=list(row.branch_ids);return ids.length?ids:[text(row.branch_id)||DEFAULT_BRANCH_ID];};

function keep<T>(ctx:PlatformAuthContext,rows:T[],branchesOf:(row:T)=>string[],query:unknown,everyWhenEmpty=false){
  const scope=branchScope(ctx);
  const requested=requestedBranchIds(scope,query);
  return rows.filter(row=>{
    const branches=branchesOf(row);
    if(!canSeeBranches(scope,branches,everyWhenEmpty))return false;
    return !requested||(!branches.length&&everyWhenEmpty)||branches.some(id=>requested.includes(id));
  });
}

/** A users list: user documents (`{ id, data }`) or workforce user rows. Viewers always see themselves. */
export function scopeUsers<T extends Row>(ctx:PlatformAuthContext,rows:T[],query?:unknown){
  const kept=new Set(keep(ctx,rows,row=>userBranchIds(row.data?record(row.data):row),query));
  return rows.filter(row=>kept.has(row)||text(row.id)===ctx.userId);
}
export function scopeGroups<T extends Row>(ctx:PlatformAuthContext,rows:T[],query?:unknown){return keep(ctx,rows,groupBranches,query);}
/** Outside companies: one with no branch works in every branch and is always visible. */
export function scopeConnections<T extends Row>(ctx:PlatformAuthContext,rows:T[],query?:unknown){return keep(ctx,rows,row=>list(row.branch_ids),query,true);}

export function assertUserVisible(ctx:PlatformAuthContext,user:Row){
  if(text(user.id)===ctx.userId)return;
  assertSeeBranches(branchScope(ctx),userBranchIds(user.data?record(user.data):user));
}
export function assertGroupVisible(ctx:PlatformAuthContext,group:Row){assertSeeBranches(branchScope(ctx),groupBranches(group));}
export function assertGroupManageable(ctx:PlatformAuthContext,group:Row,next?:Record<string,unknown>){
  const scope=branchScope(ctx);
  assertManageBranches(scope,groupBranches(group));
  if(next&&Object.prototype.hasOwnProperty.call(next,'branch_id')){
    const before=groupBranches(group);
    assertBranchChange(scope,before,[...new Set([text(next.branch_id)||DEFAULT_BRANCH_ID,...before.filter(id=>id!==text(group.branch_id))])]);
  }
}
/** A new group is made in the branch of the route; it must be one the maker manages. */
export function assertBranchManageable(ctx:PlatformAuthContext,branchId:string){assertManageBranches(branchScope(ctx),[text(branchId)||DEFAULT_BRANCH_ID]);}
export function assertConnectionVisible(ctx:PlatformAuthContext,connection:Row){assertSeeBranches(branchScope(ctx),list(connection.branch_ids),true);}
export function assertConnectionWrite(ctx:PlatformAuthContext,connection:Row|null,next:Record<string,unknown>){
  const scope=branchScope(ctx);
  const before=connection?list(connection.branch_ids):[];
  const changing=Object.prototype.hasOwnProperty.call(next,'branch_ids');
  if(!connection){
    // A new company starts in the branches it is given; a restricted maker must give it branches, all of which they manage.
    const ids=list(next.branch_ids);
    if(scope.restricted_manage&&(!ids.length||ids.some(id=>!scope.manageable_branch_ids.includes(id))))throw forbidden('branch_scope_denied','Give the company branches you manage.');
    return;
  }
  assertManageBranches(scope,before,true);
  if(changing)assertBranchChange(scope,before,list(next.branch_ids),true);
}

/**
 * The users collection on the platform document routes. `list` filters, the rest throw when the target is outside the
 * caller's reach. A restricted caller who creates a user without a branch puts them in the caller's own branch.
 */
export async function guardUserCollection(ctx:PlatformAuthContext,operation:'read'|'create'|'write',documentId:string,body?:Record<string,unknown>){
  const scope=branchScope(ctx);
  if(!scope.multiple)return;
  const payload=body?record(body.data&&typeof body.data==='object'?body.data:body):{};
  const nextBranches=()=>Object.prototype.hasOwnProperty.call(payload,'branch_id')||Object.prototype.hasOwnProperty.call(payload,'branch_ids')?userBranchIds(payload):null;
  if(operation==='create'){
    if(scope.restricted_manage&&!text(payload.branch_id)){
      const target=body?.data&&typeof body.data==='object'?record(body.data):body;
      if(target)target.branch_id=scope.my_branch_id;
    }
    const branches=nextBranches()||[scope.my_branch_id];
    if(scope.restricted_manage&&branches.some(id=>!scope.manageable_branch_ids.includes(id)))throw forbidden('branch_scope_denied','You can only add people to branches you manage.');
    return;
  }
  if(documentId===ctx.userId&&operation==='read')return;
  const document=await readDocument(ctx.orgId,'users',documentId).catch(()=>null);
  if(!document)return;
  const before=userBranchIds(document.data);
  if(operation==='read'){assertSeeBranches(scope,before);return;}
  if(documentId!==ctx.userId)assertManageBranches(scope,before);
  const after=nextBranches();
  if(after)assertBranchChange(scope,before,after);
}
