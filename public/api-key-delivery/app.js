(function () {
  "use strict";

  const ready = document.getElementById("deliveryReady");
  const result = document.getElementById("deliveryResult");
  const errorPanel = document.getElementById("deliveryError");
  const revealButton = document.getElementById("revealButton");
  const keyValue = document.getElementById("keyValue");
  const copyStatus = document.getElementById("copyStatus");
  let token = decodeURIComponent(String(location.hash || "").replace(/^#/, ""));
  let clearTimer = null;

  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  function showError(message) {
    token = "";
    if (keyValue) keyValue.value = "";
    ready.hidden = true;
    result.hidden = true;
    errorPanel.hidden = false;
    if (message) document.getElementById("errorMessage").textContent = message;
  }

  function formatDate(value) {
    if (!value) return "No expiration";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function clearKey() {
    if (keyValue) keyValue.value = "";
    document.getElementById("copyKey").disabled = true;
    document.getElementById("toggleKey").disabled = true;
    copyStatus.textContent = "The key has been cleared from this page.";
  }

  async function reveal() {
    if (!token) return showError();
    revealButton.disabled = true;
    revealButton.textContent = "Revealing…";
    try {
      const response = await fetch("/v1/public/firstmeasure/key-delivery/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ token })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false || !payload.delivery?.key) {
        throw new Error(payload.message || "This delivery link is invalid, expired, replaced, or already used. Ask your FirstMeasure contact for a new link.");
      }

      const delivery = payload.delivery;
      token = "";
      keyValue.value = delivery.key;
      document.getElementById("keyName").textContent = delivery.key_name || "FirstMeasure API key";
      document.getElementById("keyMode").textContent = String(delivery.mode || "").toUpperCase();
      document.getElementById("keyExpiration").textContent = formatDate(delivery.key_expires_at);
      ready.hidden = true;
      errorPanel.hidden = true;
      result.hidden = false;
      clearTimer = setTimeout(clearKey, 10 * 60_000);
    } catch (requestError) {
      showError(requestError.message);
    } finally {
      revealButton.disabled = false;
      revealButton.textContent = "Reveal API key";
    }
  }

  async function copyKey() {
    const key = keyValue.value;
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      copyStatus.textContent = "API key copied. Store it securely now.";
    } catch (_) {
      keyValue.type = "text";
      keyValue.focus();
      keyValue.select();
      copyStatus.textContent = "Select the key and copy it manually.";
    }
  }

  revealButton.addEventListener("click", reveal);
  document.getElementById("copyKey").addEventListener("click", copyKey);
  document.getElementById("toggleKey").addEventListener("click", () => {
    const revealText = keyValue.type === "password";
    keyValue.type = revealText ? "text" : "password";
    document.getElementById("toggleKey").textContent = revealText ? "Hide" : "Show";
  });
  window.addEventListener("pagehide", () => {
    token = "";
    if (clearTimer) clearTimeout(clearTimer);
    if (keyValue) keyValue.value = "";
  });
  window.addEventListener("hashchange", () => {
    if (location.hash) location.reload();
  });

  if (!token || !/^fmd_[a-f0-9]{20}_[A-Za-z0-9_-]{32,}$/.test(token)) showError();
})();
