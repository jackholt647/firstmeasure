(function(root){
  'use strict';
  let profile=null;
  function set(value){
    if(!value || !/^[A-Z]{3}$/.test(value.currency) || !['currency','credits'].includes(value.credit_display))throw new Error('Billing settings are unavailable.');
    if(profile && JSON.stringify(profile.report_prices)!==JSON.stringify(value.report_prices))throw new Error('Prices changed. Reload the page before ordering.');
    profile=Object.freeze({...value,report_prices:Object.freeze({...value.report_prices})});
    return profile;
  }
  function current(){if(!profile)throw new Error('Billing settings are still loading.');return profile;}
  function price(key){const value=Number(current().report_prices[key]);if(!Number.isFinite(value))throw new Error('Report price is unavailable.');return value;}
  function cash(amount,currency=current().currency,digits){
    const options={style:'currency',currency};
    if(digits!==undefined)options.minimumFractionDigits=options.maximumFractionDigits=digits;
    const result=new Intl.NumberFormat(root.PlatformLanguage?.locale?.()||undefined,options).format(Number(amount)||0);
    return currency==='USD'&&!result.includes('USD')?result+' USD':result;
  }
  function credit(amount,view=current()){
    if(view.credit_display==='credits')return new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(Number(amount)||0)+' credits';
    // Preserve the familiar dollar balance for USD accounts. Cash checkout labels
    // always identify USD explicitly, including countries which also use dollars.
    if(view.currency==='USD')return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(amount)||0);
    return cash(amount,view.currency);
  }
  function estimate(amount,exchange=current().exchange){
    return exchange?.rate>0?'Approximately '+cash(Number(amount)*exchange.rate,exchange.currency)+' · exchange rate at payment may differ.':'';
  }
  root.PlatformCommerce={set,current,price,credit,cash,estimate};
})(globalThis);
