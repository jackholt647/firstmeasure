import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { jsonValueSchema } from "../platform/publication/contracts.js";
import { contentHash } from "../platform/publication/validation.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { forbidden } from "../platform/errors.js";
import { importedLeadSchema, importLead, leadDeliveries } from "./intake.js";
let registered=false;
export function registerLeadPublication(){
 if(registered)return;registered=true;
 registerAction({id:"leads.import",version:"1",domain:"leads",description:"Import a lead with a stable source/provider identity, optional address, contacts and provenance. Duplicate source IDs never repeat lead creation.",implementation:contentHash({artifact:backendImplementationDigest(),contract:"lead-intake-1"}),
  inputSchema:zodToJsonSchema(importedLeadSchema,{$refStrategy:"none",effectStrategy:"input"}),outputSchema:jsonValueSchema,effect:"write",idempotency:"required",executionKinds:["api","agent","module","work"],
  policy:{scopes:["organization"],applications:["management"],permissions:["manage_projects"],capabilities:["platform.lead_import"]},
  execute:async(ctx,_target,input)=>{if(!ctx.auth)throw forbidden("lead_user","Sign in to import leads.");const parsed=importedLeadSchema.parse(input);return importLead(ctx.organizationId,{...parsed,branch_id:ctx.branchId||"default",source_id:`publication:${parsed.source_id}`});}
 });
 registerDataProvider({id:"lead-import",version:"1",apps:["settings"],exports:{deliveries:{description:"Lead delivery outcomes, duplicate attempts and resulting project IDs. Does not include raw messages or credentials.",schemaVersion:"1",schema:jsonValueSchema,
  access:{scopes:["organization"],permissions:["manage_projects"],capabilities:["platform.lead_import"]},
  read:async(ctx)=>{const value=await leadDeliveries(ctx.organizationId,{branchId:ctx.branchId||"default"});return {value,revision:contentHash(value)};}
 }}});
}
