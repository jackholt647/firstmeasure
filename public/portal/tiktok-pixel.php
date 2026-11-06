<?php
// TikTok Pixel for the customer portal and every landing page (FM-348).
// Pages require this file and echo fm_tiktok_pixel() in <head>, beside the Meta Pixel and Google tag.
// Requested directly this file defines the function and prints nothing.
// It also owns the browser CompleteRegistration event (FM-352): the shared signup widget
// (landing/shared/signup-widget.js) only emits firstmate:auth-success, and this listener sends
// the event once when that success created a new account. The widget itself never calls ttq,
// because the website (1m8.ai) embeds it too and counts signups with its own listener.

const FM_TIKTOK_PIXEL_ID = 'DBN2ED3C77UF91065S40';

function fm_tiktok_pixel(): string {
    $id = json_encode(FM_TIKTOK_PIXEL_ID);
    return <<<HTML
<!-- TikTok Pixel Code Start -->
<script>
!function (w, d, t) {
  w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(
var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script")
;n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};

  ttq.load({$id});
  ttq.page();
}(window, document, 'ttq');
(function () {
  if (window.__firstmateTikTokSignupTracking) return;
  window.__firstmateTikTokSignupTracking = true;
  var reported = false;
  document.addEventListener('firstmate:auth-success', function (event) {
    var host = event.target;
    // The API sets first_login only when it created the account (email or Google);
    // logins, existing Google accounts, errors and verification never do.
    if (reported || !event.detail || event.detail.first_login !== true ||
        !host || typeof host.matches !== 'function' || !host.matches('[data-firstmate-signup]')) return;
    var pixel = window.ttq;
    if (!pixel || typeof pixel.track !== 'function') return;
    try {
      pixel.track('CompleteRegistration');
      reported = true;
    } catch (e) {
      // Tracking never interrupts account creation or its redirect.
    }
  }, true);
})();
</script>
<!-- TikTok Pixel Code End -->

HTML;
}
