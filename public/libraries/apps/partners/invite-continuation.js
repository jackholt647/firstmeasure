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
  }catch(_){/* Authentication remains usable when browser storage is disabled. */}
})();
