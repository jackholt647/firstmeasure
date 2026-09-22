import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const calls = await readFile(new URL('../../libraries/apps/calls/app.js', import.meta.url), 'utf8');
const actionItems = await readFile(new URL('../../libraries/platform-action-items/platform-action-items.js', import.meta.url), 'utf8');
const crm = await readFile(new URL('../../libraries/apps/settings/crm.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../../libraries/platform-api/platform-api.js', import.meta.url), 'utf8');
const mobile = await readFile(new URL('../../portal/mobile/mobile.js', import.meta.url), 'utf8');

test('Calls consumes configured tagged follow-ups instead of project follow-up fields', () => {
  assert.match(calls, /follow_up_configuration/);
  assert.match(calls, /is_follow_up/);
  assert.match(calls, /quick_options/);
  assert.match(calls, /retry_policy/);
  assert.match(calls, /policySuggestion/);
  assert.match(calls, /data-followup-add-time/);
  assert.match(calls, /followUpInputValue/);
  assert.match(calls, /Not due until/);
  assert.match(calls, /This call isn't due until/);
  assert.match(calls, /\.calls-card-timing\{position:absolute;left:9px;bottom:8px;[^}]*width:max-content/);
  assert.match(calls, /\.dialer-timing\{align-self:flex-start;width:max-content/);
  assert.doesNotMatch(calls, /data-followup-add-time[^>]*>[\s\S]{0,100}fa-plus/);
  assert.doesNotMatch(calls, /call_followup_at|next_followup_at/);
});

test('Today renders and resolves follow-up to-dos through the shared outcome API', () => {
  assert.match(actionItems, /type_tags/);
  assert.match(actionItems, /pai-follow-up-icon/);
  assert.doesNotMatch(actionItems, /pai-follow-up-badge|border-left:3px solid #7f56d9|#f9f5ff/);
  assert.match(actionItems, /followUpOutcome/);
  assert.match(actionItems, /Follow up again/);
  assert.match(actionItems, /const dateIsFuture = !!key && key > bounds\.key/);
  assert.match(actionItems, /pai-item-stack\.is-outcome-open/);
  assert.match(actionItems, /pai-dispo-row\.pai-dispo-quick\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(actionItems, /pai-dispo-outcomes/);
  assert.match(actionItems, /openDispositionNext/);
  assert.match(actionItems, /data-follow-add-time/);
  assert.match(actionItems, /followUpInputValue/);
  assert.doesNotMatch(actionItems, /data-follow-add-time[^>]*>[\s\S]{0,100}fa-plus/);
  assert.doesNotMatch(actionItems, /data-follow-policy/);
});

test('tomorrow at 9am is counted in Future instead of the active list', () => {
  const context = { window:{ PlatformAPI:{} }, console, Date, Set, Map, URLSearchParams };
  vm.runInNewContext(actionItems, context);
  const now = new Date(2026, 6, 20, 12, 0, 0);
  const tomorrow = new Date(2026, 6, 21, 9, 0, 0).toISOString();
  const prepared = context.window.PlatformActionItems.prepareTodayList([
    { id:'follow_up_tomorrow', kind:'follow_up', status:'ready', due_at:tomorrow, metadata:{ type_tags:['follow_up'] } }
  ], { now });
  assert.equal(prepared.future.length, 1);
  assert.equal(prepared.upcoming.length, 0);
  assert.equal(prepared.current.length, 0);
});

test('Today only offers manual checkoff for manually completable work', () => {
  const context = { window:{ PlatformAPI:{} }, console, Date, Set, Map, URLSearchParams };
  vm.runInNewContext(actionItems, context);
  const { manualCompletionAllowed } = context.window.PlatformActionItems;

  assert.equal(manualCompletionAllowed({ id:'manual' }), true);
  assert.equal(manualCompletionAllowed({
    id:'payment',
    external_triggers:[{ event:'payment.received', transition:'completed' }]
  }), false);
  assert.equal(manualCompletionAllowed({
    id:'explicit-override',
    manual_completion:true,
    external_triggers:[{ event:'payment.received', transition:'completed' }]
  }), true);
  assert.equal(manualCompletionAllowed({
    id:'skip-only',
    external_triggers:[{ event:'proposal.sent', transition:'skipped' }]
  }), true);

  assert.match(actionItems, /pai-automatic/);
  assert.match(actionItems, /Completes automatically/);
  assert.match(actionItems, /pai-leading-action/);
});

test('CRM settings expose terminology, quick options, and standard outcomes', () => {
  assert.match(crm, /Follow-up behavior/);
  assert.match(crm, /Quick reschedule options/);
  assert.match(crm, /Automatic contact cadence/);
  assert.match(crm, /data-follow-policy-trigger/);
  assert.match(crm, /Completion outcomes/);
  assert.match(crm, /follow_ups:state\.followUps/);
  assert.match(crm, /Default time \(optional\)/);
  assert.match(api, /follow-ups\/\$\{enc\(nodeId\)\}\/outcome/);
});

test('mobile sales follow-up projection consumes tagged Work to-dos', () => {
  assert.match(mobile, /API\.work\?\.todos/);
  assert.match(mobile, /metadata\.type_tags/);
  assert.doesNotMatch(mobile, /project\.follow_up_at|project\.followup_at|project\.next_follow_up_at/);
});
