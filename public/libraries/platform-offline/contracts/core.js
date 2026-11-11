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
    // Public, key-authenticated and development tooling.
    '/v1/config-library/**',
    '/v1/development/**'
  ]
});
