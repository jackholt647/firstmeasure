/* public/libraries/platform-offline/contracts/index.js
 *
 * The offline contract files, in load order (docs/architecture/offline.md, "Contracts"). The service worker
 * imports each one; the top-level page loads the same list to replay the queue. Add a contract file here and a
 * case to public/v1/tests/offline-contracts.test.ts.
 */
self.FM_OFFLINE_CONTRACTS = [
  'core.js',
  'media.js'
];
