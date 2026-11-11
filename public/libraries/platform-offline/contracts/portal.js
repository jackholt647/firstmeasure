/* public/libraries/platform-offline/contracts/portal.js
 *
 * What the portal reads to start and to show its lists (docs/architecture/offline.md, "What works offline").
 *
 * A JSON GET is saved without a contract. This file adds the reads the portal makes with POST, and names the
 * reads a start needs (`boot`) so they are never evicted. Every POST read here was checked in the server to
 * change nothing; public/v1/tests/offline-contracts.test.ts keeps that list and fails on a route outside it.
 */
(function () {
  'use strict';

  const ORG = '/v1/platform/organizations/:org';

  /** A body without the fields that say who is asking (the saved read already belongs to one person) and without files. */
  function withoutActor(body) {
    const out = {};
    for (const name of Object.keys(body && typeof body === 'object' ? body : {})) {
      if (/^actor(_|$)/.test(name)) continue;
      const value = body[name];
      if (value && typeof value === 'object' && value.blob) continue;
      out[name] = value;
    }
    return out;
  }

  /**
   * Portal actions that only read (platform/api.ts handlePortalAction). Not here, on purpose:
   * `portal_bonus_upfront_match_status` starts the offer clock on first view, `portal_customer_referral_status`
   * writes the referral code on every call, and `auth_status` is the session: always the server's answer.
   */
  const PORTAL_READ_ACTIONS = [
    'org_get_my', 'get_credits', 'org_users_list_my', 'org_billing_history_my', 'org_monthly_statement',
    'pj_search', 'development_report_capability', 'portal_acquisition_bonus_offer_status'
  ];

  FMOffline.contracts.add({
    id: 'portal',
    boot: [
      // Who the person is and what their organization has switched on.
      'GET /v1/platform/me',
      'GET /v1/platform/me/localization',
      'GET /v1/platform/me/preferences',
      'GET /v1/platform/statsig/bootstrap',
      'GET /v1/config-library/read/**',
      'GET /v1/signup-sandbox/current-instance',
      'GET ' + ORG + '/capabilities',
      'GET ' + ORG + '/commerce',
      'GET ' + ORG + '/credits',
      'GET ' + ORG + '/app-flags',
      'GET ' + ORG + '/app-groups',
      'GET ' + ORG + '/attention',
      'GET ' + ORG + '/notifications',
      'GET ' + ORG + '/users',
      'GET ' + ORG + '/branch/:branch',
      'GET ' + ORG + '/branch/:branch/modules',
      'GET ' + ORG + '/branch/:branch/terminology',
      'GET /v1/workforce/organizations/:org/departments',
      'GET /v1/guided-experiences/organizations/:org/experiences',
      'GET /v1/forms/organizations/:org/staff-forms',
      'GET /v1/messaging/organizations/:org/sms/setup',
      'GET /v1/comms/organizations/:org/voice/status',
      'GET /v1/channels/organizations/:org/inbox',
      'GET /v1/channels/organizations/:org/channels',
      // The lists a start shows.
      'GET ' + ORG + '/projects',
      'GET /v1/collaboration/organizations/:org/shared',
      'GET /v1/collaboration/organizations/:org/shares',
      'GET /v1/work/organizations/:org/boards',
      'POST /v1/platform/portal-action',
      'POST /v1/firstmeasure/projects/list'
    ],
    reads: [
      {
        id: 'portal.action',
        match: 'POST /v1/platform/portal-action',
        when: (ctx) => !!ctx.body && PORTAL_READ_ACTIONS.includes(String(ctx.body.action || ''))
          // The offer's test mode writes an attribution on a developer's machine.
          && !(ctx.body.action === 'portal_acquisition_bonus_offer_status' && ctx.body.bonus_test),
        key: (ctx) => withoutActor(ctx.body)
      },
      {
        // The list of FirstMeasure orders: an organization without the platform apps lists these as its projects.
        // Only a whole list is saved. A request that carries a cursor asks for what changed since that cursor,
        // which is no use to a page that starts without the rows the cursor stands for.
        id: 'firstmeasure.projects.list',
        match: 'POST /v1/firstmeasure/projects/list',
        when: (ctx) => !!ctx.body && typeof ctx.body === 'object' && !ctx.body.cursor,
        key: (ctx) => withoutActor(ctx.body)
      },
      {
        // Published data (platform/publication/api.ts): a provider's export for a target. A draft is a question
        // about something that is not saved yet, so its answer is not kept.
        id: 'publication.data.read',
        match: 'POST /v1/publication/organizations/:org/data/read',
        when: (ctx) => !!ctx.body && !!ctx.body.provider && !(ctx.body.args && ctx.body.args.draft),
        key: (ctx) => ctx.body
      },
      {
        id: 'publication.data.list',
        match: 'POST /v1/publication/organizations/:org/data/list',
        when: (ctx) => !!ctx.body && !!ctx.body.source,
        key: (ctx) => ctx.body
      },
      {
        id: 'publication.widgets.resolve',
        match: 'POST /v1/publication/organizations/:org/widgets/resolve',
        when: (ctx) => !!ctx.body && !!ctx.body.type,
        key: (ctx) => ctx.body
      },
      {
        // Who work may be assigned to under a policy: the schedule and the project window ask with the policy as the body.
        id: 'workforce.subjects.resolve',
        match: 'POST /v1/workforce/organizations/:org/branches/:branch/assignable-subjects/resolve',
        when: (ctx) => !!ctx.body && typeof ctx.body === 'object',
        key: (ctx) => ctx.body
      },
      {
        // The feed asks which of its sources this person may see.
        id: 'feed.authorize',
        match: 'POST /v1/channels/organizations/:org/feed/authorize',
        when: (ctx) => !!ctx.body && Array.isArray(ctx.body.refs),
        key: (ctx) => ctx.body
      }
    ]
  });
})();
