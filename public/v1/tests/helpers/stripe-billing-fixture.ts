/** Deterministic provider fixture. No network or card payment is performed. */
let counter=0;const prices=new Map<string,any>();
export function stripeBillingFixture() {
  const sessions=new Map<string,any>(),subscriptions=new Map<string,any>(),invoices=new Map<string,any>(),requests=new Map<string,any>();
  const original=globalThis.fetch;
  const control={paid:true,loseResponse:false,proration:1500,creates:0,mutations:0,prices,sessions,subscriptions,invoices,calls:[] as {route:string;fields:URLSearchParams;key:string}[],restore:()=>{globalThis.fetch=original;}};
  const timestamp=()=>Math.floor(Date.now()/1000), id=(prefix:string)=>`${prefix}_${++counter}`;
  function invoice(sub:any,amount:number,paid=control.paid) {
    const value={id:id("in"),customer:sub.customer,parent:{subscription_details:{subscription:sub.id,metadata:sub.metadata}},status:paid?"paid":"open",currency:"usd",livemode:false,amount_due:amount,amount_paid:paid?amount:0,total:amount,subtotal:amount,created:timestamp(),hosted_invoice_url:"https://invoice.stripe.com/i/fixture",lines:{data:[{description:"Added subscription",amount}]}};
    invoices.set(value.id,value);sub.latest_invoice=value;return value;
  }
  globalThis.fetch=(async(input:any,options:any)=>{
    const url=new URL(String(input)),route=url.pathname.replace("/v1/","");const fields=new URLSearchParams(options.body),key=options.headers["Idempotency-Key"]||"";control.calls.push({route,fields,key});
    if(url.hostname!=="api.stripe.com")throw new Error("Unexpected network request");
    const respond=(value:any)=>new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});
    if(options.method==="GET") {
      if(route==="prices")return respond({data:[...prices.values()].filter(p=>p.lookup_key===url.searchParams.get("lookup_keys[]"))});
      if(route.startsWith("checkout/sessions/"))return respond(sessions.get(route.split("/").at(-1)!));
      if(route.startsWith("subscriptions/"))return respond(subscriptions.get(route.split("/").at(-1)!));
      if(route.startsWith("invoices/"))return respond(invoices.get(route.split("/").at(-1)!));
      throw new Error(`Unhandled GET ${route}`);
    }
    if(key&&requests.has(key))return respond(requests.get(key));
    let value:any;
    if(route==="prices") {
      value={id:id("price"),currency:"usd",livemode:false,unit_amount:Number(fields.get("unit_amount")),lookup_key:fields.get("lookup_key"),recurring:{interval:"month",interval_count:1}};prices.set(value.id,value);
    } else if(route==="invoices/create_preview") {
      value={currency:"usd",amount_due:control.proration,total:control.proration,subtotal:control.proration};
    } else if(route==="checkout/sessions") {
      control.creates++;const price=prices.get(fields.get("line_items[0][price]")!);const customer=fields.get("customer")||id("cus");
      const sub={id:id("sub"),customer,livemode:false,status:control.paid?"active":"incomplete",metadata:{billing_kind:"platform_subscription",organization_id:fields.get("metadata[organization_id]"),purchase_id:fields.get("metadata[purchase_id]")},items:{has_more:false,data:[{id:id("si"),price,quantity:1,current_period_start:timestamp(),current_period_end:timestamp()+30*86400}]},pending_update:null,cancel_at_period_end:false};
      invoice(sub,price.unit_amount);subscriptions.set(sub.id,sub);
      value={id:id("cs"),url:"https://checkout.stripe.com/c/pay/fixture",mode:"subscription",status:control.paid?"complete":"open",payment_status:control.paid?"paid":"unpaid",currency:"usd",amount_total:price.unit_amount,livemode:false,customer,subscription:sub.id,metadata:sub.metadata};sessions.set(value.id,value);
    } else if(route.startsWith("subscriptions/")) {
      control.mutations++;const sub=subscriptions.get(route.split("/").at(-1)!);
      if(fields.get("cancel_at_period_end")==="true")sub.cancel_at_period_end=true;
      else if(fields.get("items[0][deleted]")==="true")sub.items.data=sub.items.data.filter((i:any)=>i.id!==fields.get("items[0][id]"));
      else {
        const price=prices.get(fields.get("items[0][price]")!);
        const item={id:id("si"),price,quantity:1,current_period_start:timestamp(),current_period_end:sub.items.data[0].current_period_end};
        invoice(sub,control.proration);
        if(control.paid)sub.items.data.push(item);else sub.pending_update={item,expires_at:timestamp()+23*3600};
      }
      value=structuredClone(sub);
    } else if(route.endsWith("/expire")) {
      value=sessions.get(route.split("/").at(-2)!);value.status="expired";
    } else if(route.endsWith("/void")) {
      value=invoices.get(route.split("/").at(-2)!);value.status="void";const sub=subscriptions.get(value.parent.subscription_details.subscription);sub.pending_update=null;
    } else throw new Error(`Unhandled POST ${route}`);
    if(key)requests.set(key,structuredClone(value));
    if(control.loseResponse&&route!=="invoices/create_preview"&&route!=="prices") {control.loseResponse=false;throw new Error("Provider accepted request, response was lost");}
    return respond(value);
  }) as typeof fetch;
  return control;
}
