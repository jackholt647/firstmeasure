(function(){
  'use strict';
  // Runs before login analytics and auth redirects. The capability token stays
  // in this tab and is redeemed only after authenticated account/org selection.
  try{
    const url=new URL(location.href);
    const token=new URLSearchParams(url.hash.slice(1)).get('collaboration_invite')||url.searchParams.get('collaboration_invite');
    if(token&&/^[A-Za-z0-9_-]{43}$/.test(token)){
      sessionStorage.setItem('fm_collaboration_invite',token);
      url.searchParams.delete('collaboration_invite');url.hash='';
      history.replaceState(history.state,'',url.href);
    }
    // Login/signup may drop the original query. Resume in the sharing app once
    // the portal opens, before its initial navigation state is constructed.
    if(['/portal/','/portal/index.php','/portal'].includes(url.pathname)&&/^[A-Za-z0-9_-]{43}$/.test(sessionStorage.getItem('fm_collaboration_invite')||'')){
      url.searchParams.set('tab','partners');history.replaceState(history.state,'',url.href);
    }
  }catch(_){/* Authentication remains usable when browser storage is disabled. */}
})();
