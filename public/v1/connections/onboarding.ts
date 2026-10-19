import {z} from 'zod';
import {companyRequirements,onboardingSchema,onboardingStatus} from './onboarding-contract.js';
export {companyRequirements,onboardingRequirementSchema,onboardingRequirementsSchema,onboardingSchema,onboardingStatus,type Onboarding,type OnboardingRequirement,type OnboardingStatus} from './onboarding-contract.js';
import {zodToJsonSchema} from 'zod-to-json-schema';
import type {PlatformAuthContext} from '../platform/auth.js';
import {forbidden} from '../platform/errors.js';
import {registerAction} from '../platform/publication/actions.js';
import type {PublicationContext} from '../platform/publication/contracts.js';
import {backendImplementationDigest} from '../platform/publication/implementation.js';

/**
 * Onboarding an outside company: what its company types require (W-9, certificate of insurance, license, signed
 * agreement, ...), and where it stands. A requirement is defined once on a company type (`onboarding_requirements`,
 * saved with assignees.type.save). A company's own record is `metadata.onboarding` on its organization connection:
 * what was checked, dated or uploaded, always written whole. Documents are media owned by the company
 * (owner_type "company", owner_id the connection id); an expiry date on a document or a date requirement decides
 * whether the item is current, expiring (within 30 days) or expired. Nothing here blocks work: it warns.
 */
type Obj=Record<string,unknown>;
const text=(value:unknown)=>String(value??'').trim();
const record=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{};
export const onboardingSaveSchema=z.object({expected_revision:z.number().int().positive(),onboarding:onboardingSchema}).strict();
export async function saveCompanyOnboarding(ctx:PlatformAuthContext,companyId:string,input:unknown){
  const parsed=onboardingSaveSchema.parse(input);
  const storage=await import('./storage.js');
  const current=await storage.readOrganizationConnection(ctx.orgId,companyId);
  const {assertConnectionWrite}=await import('../workforce/branch-guards.js');
  assertConnectionWrite(ctx,current as never,{});
  const saved=await storage.patchOrganizationConnection(ctx.orgId,companyId,{expected_revision:parsed.expected_revision,metadata:{onboarding:parsed.onboarding}});
  const {listCompanyTypes,assigneeTypeIds}=await import('../assignees/base.js');
  const typeIds=await assigneeTypeIds(ctx.orgId,{type:'organization_connection',id:text(saved.id)} as never);
  const requirements=companyRequirements(await listCompanyTypes(ctx.orgId) as never,typeIds);
  return {id:text(saved.id),revision:Number(saved.revision),onboarding:onboardingSchema.parse(record(record(saved.metadata).onboarding)),status:onboardingStatus(requirements,record(saved.metadata).onboarding)};
}

let registered=false;
export function registerCompanyOnboardingPublication(){
  if(registered)return;
  registered=true;
  registerAction({
    id:'connections.onboarding.save',version:'1',domain:'workforce',effect:'write',executionKinds:['api','agent'],idempotency:'required',implementation:backendImplementationDigest(),
    description:'save an outside company\'s onboarding record: which requirements of its company types are checked or dated, and the documents uploaded for them (media owned by the company), with expiry dates. The whole record is written. The target id is the company.',
    inputSchema:zodToJsonSchema(onboardingSaveSchema,{$refStrategy:'none'}) as Obj,
    outputSchema:{type:'object',required:['id','revision','onboarding','status'],properties:{id:{type:'string'},revision:{type:'integer'},onboarding:{type:'object'},status:{type:'object'}},additionalProperties:false},
    policy:{scopes:['organization'],permissions:['manage_company_settings']},
    execute:async(ctx:PublicationContext,target,input)=>{
      if(!ctx.auth)throw forbidden('onboarding_denied','A signed-in person is required.');
      return saveCompanyOnboarding(ctx.auth,text((target as Obj).id),input);
    }
  } as Parameters<typeof registerAction>[0]);
}
