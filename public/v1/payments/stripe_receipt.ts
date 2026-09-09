export function stripeCreditReceiptDescription(creditDollars: number) {
  const safeAmount = Number.isFinite(creditDollars) ? Math.max(0, creditDollars) : 0;
  const formattedAmount = (Math.round(safeAmount * 100) / 100).toFixed(2).replace(/\.00$/, "");
  return `$${formattedAmount} in credits added to your FirstMate balance. Roof reports come out of this balance; you won't be charged again until you reload.`;
}
