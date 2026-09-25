// Reference rates are display estimates only. Stripe/card issuers own conversion.
type Rates={date:string;rates:Record<string,number>};
let cached:Rates|null=null,lastAttempt=0,pending:Promise<Rates|null>|null=null;
export function parseReferenceRates(xml:string):Rates {
  const date=xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  const rates:Record<string,number>={EUR:1};
  for(const match of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const rate=Number(match[2]);if(Number.isFinite(rate)&&rate>0)rates[match[1]!]=rate;
  }
  if(!date||!rates.USD)throw new Error("Invalid reference rates");
  return {date,rates};
}
export async function exchangeEstimate(base:string,local:string) {
  if(base===local)return null;
  if(Date.now()-lastAttempt>3600000 && !pending) {
    lastAttempt=Date.now();
    pending=(async()=>{
      try {const response=await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",{signal:AbortSignal.timeout(2500)});
        if(!response.ok)throw new Error("Reference rates unavailable");cached=parseReferenceRates(await response.text());
      }catch{/* An unavailable estimate never changes or blocks the actual price. */}
      return cached;
    })().finally(()=>{pending=null;});
  }
  if(pending)await pending;
  if(!cached || Date.now()-Date.parse(cached.date)>7*86400000 || !cached.rates[base] || !cached.rates[local])return null;
  return {currency:local,rate:cached.rates[local]/cached.rates[base],date:cached.date,source:"ECB",approximate:true};
}
