/* public/libraries/platform-offline/contracts/core.js
 *
 * The core contract: routes the worker never saves, answers or queues, whatever an app contract says. Nothing
 * here belongs to one app. A pattern without a method covers every method.
 */
FMOffline.contracts.add({
  id: 'core',
  deny: [
    // Sign-in, sign-out, sessions and account switching: always the server's answer.
    '/v1/platform/auth/**',
    // The realtime stream and its poll fallback are never intercepted; nor is any other stream.
    '/v1/**/events/stream',
    '/v1/**/events/poll',
    '/v1/**/stream',
    '/v1/**/collab/**',
    // Payments: checkout, saved cards and processor data are never kept on the device.
    '/v1/payments/**',
    '/v1/platform-billing/**',
    // Session replay: recorder chunks and the administrators' viewer.
    '/v1/session-replay/**',
    '/v1/platform/session-replay/**',
    // Assistant and agent conversations answer as they are generated.
    '/v1/assistant/**',
    '/v1/agents/**',
    // Offline's own endpoints: the asset manifest is the kill switch and must be the server's.
    '/v1/platform/offline/**',
    // Development tooling. (The config library's public reads, /v1/config-library/read/..., are saved: the app
    // reads its terminology and tab defaults from them at start.)
    '/v1/development/**'
  ]
});

// DEMO ONLY, never committed (offline photos, 2026-11-11): contracts/index.js on the dev live layer belongs to another
// checkout and does not list the media contract yet, so for the length of the demo it is loaded from here: by the
// worker directly, and by a page through the list it reads next.
if (typeof importScripts === 'function') { try { importScripts('/libraries/platform-offline/contracts/media.js'); } catch (error) { console.warn('[offline] media contract not loaded', error); } }
else if (Array.isArray(self.FM_OFFLINE_CONTRACTS) && !self.FM_OFFLINE_CONTRACTS.includes('media.js')) self.FM_OFFLINE_CONTRACTS.push('media.js');
