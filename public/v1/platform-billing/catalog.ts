import { billingStore } from "./storage.js";
import { createPrice, publishPrice, catalog } from "./service.js";

/** Explicit operator installation. Reads and deployments never enroll customers. */
export async function installStandardCatalog(actor:string) {
  const definitions = [
    {product_id:"sms",plan_key:"basic",name:"SMS Basic",capability_key:"comms.sms",monthly_cents:3000,description:"Stay in touch with customers by text. Includes 1,000 outgoing messages each subscription month.",highlights:["Customer conversations and project updates","1,000 outgoing messages per monthly billing period","Sending pauses at your allowance; upgrade whenever you need more","Carrier registration and customer consent are required"],allowances:{sms_messages:1000}},
    {product_id:"sms",plan_key:"advanced",name:"SMS Advanced",capability_key:"comms.sms",monthly_cents:10000,description:"More room for growing teams: 5,000 outgoing messages per subscription month.",highlights:["Everything in SMS Basic","5,000 outgoing messages per monthly billing period","Upgrade without paying twice for your current plan","Sending pauses at the allowance; no automatic overage charges"],allowances:{sms_messages:5000}},
    {product_id:"advanced_ai",plan_key:"default",name:"Advanced AI",capability_key:"platform.advanced_ai",monthly_cents:2000,description:"An optional AI upgrade for your team. The included advanced capabilities are being finalized; this description is a placeholder.",highlights:["Basic AI stays included at no extra subscription charge","Advanced feature details coming soon"],placeholder:true},
    ...[["10gb","10 GB",10_000_000_000,500],["100gb","100 GB",100_000_000_000,1500],["1tb","1 TB",1_000_000_000_000,5000],["10tb","10 TB",10_000_000_000_000,25000]].map(([key,label,bytes,cents])=>({product_id:"storage",plan_key:String(key),name:`Storage · ${label}`,capability_key:"platform.purchasable_storage",monthly_cents:Number(cents),description:`Upgrade your total platform media storage allowance to ${label}. Placeholder monthly pricing for this development offering.`,highlights:[`${label} total media storage (decimal GB/TB)`,"Includes stored originals and generated media renditions","Change tiers from Billing; existing files are never deleted by a downgrade"],allowances:{storage_bytes:Number(bytes)},placeholder:true}))
  ];
  return billingStore().transaction(async()=>{
  const existing=await catalog(true),installed=[];
  for(const definition of definitions) {
    const prior=existing.filter(p=>p.product_id===definition.product_id && (p.plan_key||"default")===definition.plan_key).sort((a,b)=>b.version-a.version)[0];
    // Operator edits win. Running installation again never changes accepted prices.
    installed.push(prior||await publishPrice((await createPrice(definition,actor)).id,actor));
  }
  return installed;
  },"catalog");
}
