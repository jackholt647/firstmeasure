import test from 'node:test';
import assert from 'node:assert/strict';
import { listWorkEventDefinitions, notificationEventGroups, notificationEventSources, registerWorkEvents, workEventDefinition, workEventNotification } from '../work/events.js';

test('registered built-ins have intentional notification groups and sources', () => {
  const events = listWorkEventDefinitions();
  assert.ok(events.length > 100);
  for (const event of events) {
    assert.ok(notificationEventGroups[event.notification.group], event.name);
    assert.ok(notificationEventSources[event.notification.source], event.name);
    assert.ok(['general', 'messaging', 'flows', 'scopes', 'documents'].includes(event.notification.tab), event.name);
    assert.notEqual(event.notification.group, 'miscellaneous', event.name);
  }
});

test('semantic groups span sources without changing event identity or visibility', () => {
  for (const name of ['document.signed', 'document.signature.accepted', 'proposal.esign.completed', 'project.completion.signed']) {
    assert.equal(workEventNotification(name).group, 'signatures', name);
  }
  for (const name of ['payment.received', 'document.payment.received', 'proposal.payment.received', 'invoice.sent']) {
    assert.equal(workEventNotification(name).group, 'payments', name);
  }
  assert.equal(workEventNotification('document.payment.received').source, 'documents');
  assert.equal(workEventNotification('payment.received').source, 'billing');
  assert.equal(workEventDefinition('document.signed').visibility, 'activity');
  assert.equal(workEventNotification('work.plan.completed').tab, 'scopes');
  assert.equal(workEventNotification('communication.received').tab, 'messaging');
});

test('registration requires valid grouping; unknown events retain miscellaneous fallback', () => {
  assert.throws(() => registerWorkEvents([{ name: 'fixture.no_group' } as any]), /must declare/);
  assert.throws(() => registerWorkEvents([{ name: 'fixture.bad_group', notification: { group: 'unknown', source: 'general', tab: 'general' } } as any]), /must declare/);
  assert.throws(() => registerWorkEvents([{ name: 'fixture.prototype_group', notification: { group: '__proto__', source: 'general', tab: 'general' } } as any]), /must declare/);
  registerWorkEvents([{ name: 'fixture.explicit_miscellaneous', notification: { group: 'miscellaneous', source: 'general', tab: 'general' } }]);
  assert.deepEqual(workEventNotification('fixture.explicit_miscellaneous'), { group: 'miscellaneous', source: 'general', tab: 'general' });
  assert.deepEqual(workEventNotification('unregistered.event'), { group: 'miscellaneous', source: 'general', tab: 'general' });
  assert.equal(workEventDefinition('unregistered.event').customer, undefined);
});
