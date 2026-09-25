import { creditLabel, currentProfile, type CommercialProfile } from "../commerce/profile.js";
export function stripeCreditReceiptDescription(creditDollars: number, profile: CommercialProfile = currentProfile()) {
  const safeAmount = Number.isFinite(creditDollars) ? Math.max(0, creditDollars) : 0;
  const formattedAmount = (Math.round(safeAmount * 100) / 100).toFixed(2).replace(/\.00$/, "");
  return `${profile.credit_display==="credits"?formattedAmount+" credits":profile.currency==="USD"?"$"+formattedAmount:creditLabel(Number(formattedAmount), profile)}${profile.credit_display==="credits"?"":" in credits"} added to your FirstMate balance. Roof reports come out of this balance; you won't be charged again until you reload.`;
}
