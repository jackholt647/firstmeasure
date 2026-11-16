import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closePlatformFixtureStores } from './helpers/platform-fixture.js';
const dir = await mkdtemp(path.join(os.tmpdir(), 'domain-email-'));
Object.assign(process.env, { NODE_ENV: 'test', PLATFORM_STORAGE_ROOT: path.join(dir, 'platform'), PRICEBOOK_STORAGE_ROOT: path.join(dir, 'pricebook'), MESSAGING_STORAGE_ROOT: path.join(dir, 'messaging'), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, 'firstmeasure'), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, 'index.sqlite'), PLATFORM_HEARTBEAT_DISABLED: '1', FIRSTMEASURE_JOB_WORKERS: '0', DOMAIN_INFRASTRUCTURE_MODE: 'capture', EMAIL_DELIVERY_MODE: 'capture' });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }); });

type Zone = { mx: Record<string, string[]>; txt: Record<string, string[]>; ns: Record<string, string[]> };
/** A public DNS stand-in: what the domain serves. */
function resolver(zone: Zone) {
  const missing = () => Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  return {
    async resolveMx(name: string) { const hosts = zone.mx[name]; if (!hosts) throw missing(); return hosts.map((exchange, index) => ({ exchange, priority: (index + 1) * 10 })); },
    async resolveTxt(name: string) { const values = zone.txt[name]; if (!values) throw missing(); return values.map((value) => [value]); },
    async resolveNs(name: string) { const hosts = zone.ns[name]; if (!hosts) throw missing(); return hosts; }
  };
}
const CF_MX = ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net', 'route3.mx.cloudflare.net'];
function servedRecords(domain: string): Zone {
  return {
    mx: { [domain]: CF_MX, [`cf-bounce.${domain}`]: CF_MX },
    txt: {
      [domain]: ['v=spf1 include:_spf.mx.cloudflare.net ~all', 'google-site-verification=abc'],
      [`cf-bounce.${domain}`]: ['v=spf1 include:_spf.mx.cloudflare.net ~all'],
      [`cf-bounce._domainkey.${domain}`]: ['v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest'],
      [`_dmarc.${domain}`]: ['v=DMARC1; p=quarantine;']
    },
    ns: {}
  };
}

// FM-516: what a customer domain must serve for FirstMate email, and how the check reads public DNS.
test('the email records check finds, misses and flags conflicting records', async () => {
  const { domainEmailRecords, checkDomainEmailRecords, mergeProviderRecords } = await import('../domains/email-records.js');
  const records = domainEmailRecords('acme.test');
  assert.deepEqual(records.map((record) => `${record.type} ${record.name}`), [
    'MX acme.test', 'MX acme.test', 'MX acme.test', 'TXT acme.test',
    'MX cf-bounce.acme.test', 'MX cf-bounce.acme.test', 'MX cf-bounce.acme.test', 'TXT cf-bounce.acme.test',
    'TXT cf-bounce._domainkey.acme.test', 'TXT _dmarc.acme.test'
  ]);

  const all = await checkDomainEmailRecords(records, resolver(servedRecords('acme.test')));
  assert.ok(all.every((record) => record.status === 'found'), JSON.stringify(all.filter((record) => record.status !== 'found')));

  const zone = servedRecords('acme.test');
  zone.mx['acme.test'] = [...CF_MX, 'aspmx.l.google.com'];
  zone.txt['cf-bounce.acme.test'] = ['v=spf1 include:_spf.mx.cloudflare.net ~all', 'v=spf1 include:_spf.google.com ~all'];
  delete zone.txt['cf-bounce._domainkey.acme.test'];
  const status = Object.fromEntries((await checkDomainEmailRecords(records, resolver(zone))).map((record) => [record.key, record.status]));
  assert.equal(status.mx_1, 'conflict', 'another mail server on the root splits inbound mail');
  assert.equal(status.bounce_spf, 'conflict', 'two SPF records at one name');
  assert.equal(status.dkim, 'missing');
  assert.equal(status.dmarc, 'found', 'any DMARC policy is the customer\'s choice');

  // Cloudflare's issued DKIM key replaces the placeholder and is what the check then requires.
  const issued = mergeProviderRecords(records, [{ type: 'TXT', name: 'cf-bounce._domainkey.acme.test', content: 'v=DKIM1; h=sha256; k=rsa; p=ISSUEDKEY' }], 'email_sending');
  const dkim = issued.find((record) => record.key === 'dkim')!;
  assert.equal(dkim.content, 'v=DKIM1; h=sha256; k=rsa; p=ISSUEDKEY');
  assert.equal(dkim.issued_by_provider, undefined);
  const wrongKey = await checkDomainEmailRecords([dkim], resolver(servedRecords('acme.test')));
  assert.equal(wrongKey[0]!.status, 'missing', 'a different DKIM key is not the issued one');
  // A key issued under another selector: the placeholder is dropped and the issued record is expected instead.
  const other = mergeProviderRecords(records, [{ type: 'TXT', name: 'cf2025._domainkey.acme.test', content: 'v=DKIM1; p=OTHER' }], 'email_sending');
  assert.ok(!other.some((record) => record.key === 'dkim'));
  assert.ok(other.some((record) => record.name === 'cf2025._domainkey.acme.test'));
});

test('the Cloudflare client onboards a zone for email routing and sending', async () => {
  const { createCloudflareClient } = await import('../domains/cloudflare.js');
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const route = `${init.method || 'GET'} ${String(url).replace('https://cf.test', '')}`;
    calls.push(route + (init.body ? ` ${init.body}` : ''));
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (route === 'GET /zones/z1/email/sending/subdomains') return ok([]);
    if (route === 'POST /zones/z1/email/sending/subdomains') return ok({ tag: 'tag1', name: 'acme.test', enabled: true });
    if (route === 'GET /zones/z1/email/sending/subdomains/tag1/dns') return ok([{ type: 'TXT', name: 'cf-bounce._domainkey.acme.test', content: 'v=DKIM1; p=KEY' }]);
    if (route === 'GET /zones/z1/email/routing/dns') return ok({ record: [{ type: 'MX', name: 'acme.test', content: 'route1.mx.cloudflare.net', priority: 13 }] });
    return ok({});
  }) as typeof fetch;
  const cloudflare = createCloudflareClient({ accountId: 'acct', apiToken: 'token', apiBaseUrl: 'https://cf.test', fetchImpl });
  await cloudflare.enableEmailRouting('z1', 'acme.test');
  await cloudflare.routeAllMailToWorker('z1', 'firstmate-email-router');
  assert.deepEqual(await cloudflare.emailRoutingDnsRecords('z1'), [{ type: 'MX', name: 'acme.test', content: 'route1.mx.cloudflare.net', priority: 13 }]);
  const sending = await cloudflare.ensureEmailSendingDomain('z1', 'acme.test');
  assert.equal(sending.tag, 'tag1');
  assert.equal((await cloudflare.emailSendingDnsRecords('z1', 'tag1'))[0]!.content, 'v=DKIM1; p=KEY');
  assert.ok(calls.some((call) => call.startsWith('PUT /zones/z1/email/routing/rules/catch_all') && call.includes('"type":"worker"') && call.includes('firstmate-email-router')));
  assert.ok(calls.includes('POST /zones/z1/email/routing/dns {"name":"acme.test"}'));
});

test('a company domain sends and receives once its records check out, with FirstMate Mail as the fallback', async () => {
  await import('../chat/capabilities.js'); await import('../comms/capabilities.js');
  const storage = await import('../platform/storage.js');
  const orgId = 'org_domain_email';
  await storage.createOrganization({ id: orgId, name: 'Acme Roofing' });
  const engine = await import('../email/engine.js');
  const domains = await import('../domains/service.js');
  const domainStorage = await import('../domains/storage.js');
  const { listSenderIdentities, readMessageRecord } = await import('../messaging/communications_storage.js');
  const { processInboundEmail } = await import('../email/inbound.js');
  const auth = { orgId, userId: 'owner', role: 'owner', permissions: { '*': true }, branchId: 'default' } as any;
  const domain = 'acme-roofing.test';

  const mail = await engine.ensureOrgEmailInbox(orgId);
  const sender = async () => {
    const sent = await engine.sendEngineEmail(orgId, { recipients: [{ address: 'customer@example.com' }], subject: 'Hello', text: 'Hi' }) as any;
    return (await readMessageRecord(orgId, sent.message.id)).sender.address as string;
  };
  const defaults = async () => (await listSenderIdentities(orgId, 'default', 'email')).filter((identity) => identity.is_default).map((identity) => identity.address);

  await domains.connectExistingDomain({ orgId, domain, actorUserId: 'owner' });
  await assert.rejects(() => domains.checkDomainEmail(orgId, domain), /email address first|Verify/);
  await domainStorage.saveRegistration(orgId, domain, { ...(await domainStorage.readRegistration(orgId, domain)), status: 'ready_to_connect', verified_at: new Date().toISOString() });
  const attached = await domains.attachDomainResources({ orgId, domain, website: { mode: 'none' }, defaultEmailLocalPart: 'office', context: auth });

  // Capture mode records the records the domain should serve; nothing is in DNS yet, so mail still goes out from FirstMate Mail.
  assert.equal(attached.registration.email_configuration_status, 'records_pending');
  assert.ok((attached.registration.email_records as any[]).some((record) => record.key === 'dmarc'));
  assert.deepEqual(await defaults(), [mail.address], 'the domain is not the sender until it checks out');
  assert.equal(await sender(), mail.address);
  // Creating FirstMate Mail again never takes the default from the domain (it already exists here; the flag stays put).
  await engine.ensureOrgEmailInbox(orgId);

  // Inbound for the verified domain lands in the company inbox already, for its address and any other at the domain.
  const inbound = await processInboundEmail({ provider: 'cloudflare_email', provider_event_id: 'evt-1', from: { address: 'homeowner@example.com' }, to: [{ address: 'sales@acme-roofing.test' }], subject: 'Quote?', text: 'Hi' } as any);
  assert.equal(inbound.message.organization_id, orgId);
  assert.equal((await engine.findEmailInboxOwner('office@acme-roofing.test'))?.organization_id, orgId);
  assert.equal(await engine.findEmailInboxOwner('someone@unconnected.test'), null);

  // The records check: missing, then found.
  const missing = await domains.checkDomainEmail(orgId, domain, { resolver: resolver({ mx: {}, txt: {}, ns: {} }) });
  assert.equal(missing.ready, false);
  assert.equal(missing.registration.email_configuration_status, 'records_pending');
  const found = await domains.checkDomainEmail(orgId, domain, { resolver: resolver(servedRecords(domain)) });
  assert.equal(found.ready, true);
  assert.equal(found.registration.email_configuration_status, 'active');
  assert.deepEqual(await defaults(), ['office@acme-roofing.test']);
  assert.equal(await sender(), 'office@acme-roofing.test');
  await engine.ensureOrgEmailInbox(orgId);
  assert.deepEqual(await defaults(), ['office@acme-roofing.test'], 'FirstMate Mail does not take the default back');

  // The setup's done page reads the domain as ready and shows its address.
  const { emailDomainStatus } = await import('../comms/setup.js');
  assert.deepEqual(await emailDomainStatus(orgId), { name: domain, address: 'office@acme-roofing.test', state: 'ready' });

  // Records go missing: back to FirstMate Mail until they return.
  const lost = await domains.checkDomainEmail(orgId, domain, { resolver: resolver({ mx: {}, txt: {}, ns: {} }) });
  assert.equal(lost.registration.email_configuration_status, 'records_pending');
  assert.deepEqual(await defaults(), [mail.address]);
  assert.equal(await sender(), mail.address);

  // Disconnecting the domain stops its inbox.
  await domains.checkDomainEmail(orgId, domain, { resolver: resolver(servedRecords(domain)) });
  await domains.disconnectDomainFromFirstMate({ orgId, domain, context: auth });
  assert.equal(await engine.findEmailInboxOwner('office@acme-roofing.test'), null);
  assert.equal(await sender(), mail.address);
});

test('a new FirstMate Mail inbox leaves a sending domain the default, and a simulated domain checks out at once', async () => {
  const storage = await import('../platform/storage.js');
  const orgId = 'org_domain_email_sim';
  await storage.createOrganization({ id: orgId, name: 'Sim Roofing' });
  const engine = await import('../email/engine.js');
  const domains = await import('../domains/service.js');
  const domainStorage = await import('../domains/storage.js');
  const { listSenderIdentities } = await import('../messaging/communications_storage.js');
  const domain = 'sim-roofing.test';
  // A domain bought in registry test mode: simulated and verified, with nothing in public DNS.
  await domainStorage.saveRegistration(orgId, domain, { acquisition_type: 'register', status: 'ready_to_connect', simulated: true, verified_at: new Date().toISOString() });
  const attached = await domains.attachDomainResources({ orgId, domain, website: { mode: 'none' }, defaultEmailLocalPart: 'info', context: { orgId, userId: 'owner', branchId: 'default' } as any });
  assert.equal(attached.registration.email_configuration_status, 'active', 'attach runs the check; simulated records are found');
  // The domain was connected before any FirstMate Mail inbox existed: creating it now must not take the default.
  const mail = await engine.ensureOrgEmailInbox(orgId);
  assert.equal(mail.is_default, false);
  const identities = await listSenderIdentities(orgId, 'default', 'email');
  assert.deepEqual(identities.filter((identity) => identity.is_default).map((identity) => identity.address), ['info@sim-roofing.test']);
  assert.equal((await engine.resolveOrgEmailSender(orgId)).address, 'info@sim-roofing.test');
});
