/* Forward sandbox onboarding modal, available from every portal surface. */
(function(root){
  let active = null;
  let pending = null;

  function currentOrgId(){
    return String(root.Portal?.cfg?.userOrgId || root.Portal?.cfg?.orgId || root.__APP?.userOrgId || '').trim();
  }

  function openLink(url, options = {}){
    if (active) return active;
    const link = String(url || '').trim();
    if (!/^https:\/\/[^/]+\.getfwd\.com\//i.test(link)) throw new Error('Forward application link is unavailable.');
    const overlay = document.createElement('div');
    overlay.dataset.fmWizard = 'money-onboarding';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483300;display:flex;align-items:center;justify-content:center;box-sizing:border-box;background:rgba(15,23,42,.46);padding:16px';
    overlay.innerHTML = `<div role="dialog" aria-modal="true" aria-label="Secure payment setup" style="display:flex;flex-direction:column;width:min(1180px,100%);height:min(94vh,1050px);min-height:500px;overflow:hidden;border-radius:16px;background:#fff;box-shadow:0 28px 90px rgba(15,23,42,.3)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid #e4e7ec"><strong>Secure payment setup</strong><button type="button" data-mp-close aria-label="Close payment setup" style="border:0;background:transparent;font-size:26px;cursor:pointer">&times;</button></div>
      <iframe title="Forward merchant application" style="flex:1;width:100%;border:0;background:#fff" allow="camera; clipboard-write"></iframe>
    </div>`;
    const frame = overlay.querySelector('iframe');
    frame.src = link;
    document.body.appendChild(overlay);
    let closed = false;
    let modalHandle = null;
    let fallbackKeydown = null;
    const close = () => {
      if (closed) return;
      closed = true;
      root.removeEventListener('message', onReturn);
      if (fallbackKeydown) document.removeEventListener('keydown', fallbackKeydown, true);
      try { modalHandle?.unregister?.(); } catch (error) { /* already closed */ }
      overlay.remove();
      active = null;
      try { options.onClose?.(); } catch (error) { /* caller refresh is best effort */ }
      root.dispatchEvent(new CustomEvent('fm:payments-setup-closed'));
      root.PlatformBanners?.load?.(currentOrgId());
    };
    const onReturn = (event) => {
      if (event.origin === root.location.origin && event.source === frame.contentWindow
        && event.data?.type === 'firstmate:payments-setup-return') close();
    };
    active = { el:overlay, close };
    root.addEventListener('message', onReturn);
    overlay.querySelector('[data-mp-close]')?.addEventListener('click', close);
    modalHandle = root.Portal?.modals?.register?.(overlay, { id:'money-onboarding', closeOnEscape:true, closeOnBackdrop:true, onClose:close }) || null;
    if (!modalHandle) {
      fallbackKeydown = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); } };
      document.addEventListener('keydown', fallbackKeydown, true);
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    }
    return active;
  }

  function open(options = {}){
    if (active) return Promise.resolve(true);
    if (pending) return pending;
    pending = (async () => {
      const orgId = String(options.orgId || currentOrgId()).trim();
      if (!orgId || !root.PaymentsAPI?.merchantConfig?.get) throw new Error('Payment setup is unavailable.');
      const config = await root.PaymentsAPI.merchantConfig.get(orgId);
      if (config?.forward_environment !== 'sandbox' || config?.merchant_config?.provider !== 'forward') return false;
      const result = await root.PaymentsAPI.merchantBoarding.hostedSignup(orgId, {});
      if (!result?.link?.url) {
        root.PlatformBanners?.load?.(orgId);
        root.PlatformUI?.showToast?.('Your payment application has already been submitted.');
        return true;
      }
      openLink(result.link.url, options);
      return true;
    })().finally(() => { pending = null; });
    return pending;
  }

  root.FirstMatePaymentsSetup = { open, openLink, get active(){ return active; } };
})(window);
