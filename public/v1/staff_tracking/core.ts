import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';

export const RETENTION_DAYS = 90;
export const SAMPLE_MS = 300_000;
export function enabled() { return process.env.STAFF_TRACKING_ENABLED === '1'; }
export function reference(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function normalizeIp(raw: string): string | null {
  let ip = raw.trim();
  if (ip.includes('%')) return null; // Scope IDs are local interface details, not visitor IPs.
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  const version = isIP(ip);
  if (!version) return null;
  if (version === 4) return ip;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (mapped) { const a=parseInt(mapped[1]!,16),b=parseInt(mapped[2]!,16);return `${a>>8}.${a&255}.${b>>8}.${b&255}`; }
  return canonical;
}
export function visitorIp(peer: string, forwarded: string, trustedCidrs = process.env.STAFF_TRACKING_TRUSTED_PROXIES || '') {
  const trusted = new BlockList();
  for (const entry of trustedCidrs.split(',').map(x => x.trim()).filter(Boolean)) {
    const [address, prefix] = entry.split('/');
    const ip = normalizeIp(address!); if (!ip) throw new Error('Invalid tracking proxy configuration');
    const family = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
    if (prefix == null) trusted.addAddress(ip, family);
    else trusted.addSubnet(ip, Number(prefix), family);
  }
  let current = normalizeIp(peer);
  if (!current) return null;
  const hops = forwarded ? forwarded.split(',') : [];
  if (hops.length > 16) return null;
  // Start at the socket, not the client-controlled leftmost header.
  while (trusted.check(current, isIP(current) === 4 ? 'ipv4' : 'ipv6')) {
    if (!hops.length) return null;
    current = normalizeIp(hops.pop()!); if (!current) return null;
  }
  // Private/loopback endpoints without a complete verified chain are gaps.
  const privateIps = new BlockList();
  for (const [ip, bits] of [['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['127.0.0.0',8],['169.254.0.0',16],['0.0.0.0',8]] as const) privateIps.addSubnet(ip,bits,'ipv4');
  privateIps.addSubnet('fc00::',7,'ipv6'); privateIps.addSubnet('fe80::',10,'ipv6'); privateIps.addAddress('::1','ipv6'); privateIps.addAddress('::','ipv6');
  return privateIps.check(current,isIP(current)===4?'ipv4':'ipv6') ? null : current;
}
export function browserFamily(ua: string) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  return `${browser} / ${os}`;
}
export type TrackingEvent = {
  id: string; email: string; name: string; at: string; ip: string | null;
  kind: 'activity' | 'session_seen' | 'training_start' | 'exam_start' | 'exam_submit' | 'training_submit';
  session_ref: string; browser: string; established: boolean; impersonated: boolean;
  course: string; attempt: string; project: string;
};
export function fullAdmin(user: Record<string, any> | null) {
  return !!user && !user.disabled && user.status === 'active' && user.account_type !== 'customer' &&
    (['admin','system_admin'].includes(String(user.role).toLowerCase()) || user.is_admin === true || user.permissions?.is_admin_legacy === true || user.permissions?.platform_admin === true);
}
export function activeStaff(user: Record<string, any> | null) {
  return !!user && !user.disabled && user.status === 'active' && user.account_type !== 'customer';
}
export type Signal = { key: string; priority: 'review' | 'high'; reason: string; matches: TrackingEvent[] };
export function signalsFor(event: TrackingEvent, prior: TrackingEvent[]): Signal[] {
  if (!event.ip || event.impersonated) return [];
  const earlier = prior.filter(p => !p.impersonated && p.ip && p.at < event.at && p.at >= new Date(Date.parse(event.at)-RETENTION_DAYS*86400000).toISOString());
  const sameUser = earlier.filter(p => p.email === event.email);
  const result: Signal[] = [];
  const matches = earlier.filter(p => p.email !== event.email && p.ip === event.ip && p.established);
  if (/^(exam|training)_/.test(event.kind) && matches.length) result.push({key:'prior_staff_ip',priority:'high',reason:'Training/exam IP previously observed on another established staff account. Shared networks remain possible.',matches});
  if (sameUser.length && !sameUser.some(p=>p.ip===event.ip)) result.push({key:'new_ip',priority:'review',reason:'IP not previously observed for this account within retention.',matches:sameUser.slice(0,1)});
  const attempt = sameUser.filter(p=>event.attempt && p.course===event.course && p.attempt===event.attempt && p.ip!==event.ip);
  if (attempt.length) result.push({key:'attempt_ip_change',priority:'review',reason:'Different IP observed during the same attempt.',matches:attempt});
  const overlap = sameUser.filter(p=>p.ip!==event.ip && Date.parse(event.at)-Date.parse(p.at)<=10*60000);
  if (overlap.length) result.push({key:'near_concurrent',priority:'review',reason:'Different IP observed within ten minutes; sampling does not prove simultaneous use.',matches:overlap});
  return result;
}
