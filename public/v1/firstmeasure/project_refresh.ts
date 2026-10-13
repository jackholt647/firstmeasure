import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../src/config/env.js';

type Row = { id?: unknown; [key: string]: unknown };
type Cursor = { scope: string; expires: number; rows: Record<string, string> };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sign = (body: string) => createHmac('sha256', env.platformSessionSecret).update('firstmeasure-refresh-v1:' + body).digest('base64url');

// A cursor is only a comparison baseline, never authority. Callers must load
// the currently authorized page before using it, including after revocation.
export function projectPageChanges(scope: unknown, rows: Row[], supplied?: unknown) {
  const scopeHash = digest(scope);
  let previous: Cursor | null = null;
  if (typeof supplied === 'string' && supplied.length < 100_000) {
    try {
      const [body, signature] = supplied.split('.');
      if (!body) throw new Error('Missing cursor body');
      const expected = Buffer.from(sign(body)); const actual = Buffer.from(signature || '');
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
        const candidate = JSON.parse(Buffer.from(body, 'base64url').toString()) as Cursor;
        if (candidate.scope === scopeHash && candidate.expires > Date.now()) previous = candidate;
      }
    } catch { /* Invalid or expired cursors require a fresh authorized snapshot. */ }
  }
  const versions = Object.fromEntries(rows.map(row => [String(row.id), digest(row)]));
  const body = Buffer.from(JSON.stringify({ scope: scopeHash, expires: Date.now() + 30 * 60_000, rows: versions })).toString('base64url');
  return {
    reset: !previous,
    projects: previous ? rows.filter(row => previous!.rows[String(row.id)] !== versions[String(row.id)]) : rows,
    removed: previous ? Object.keys(previous.rows).filter(id => !(id in versions)) : [],
    order: rows.map(row => String(row.id)),
    cursor: body + '.' + sign(body)
  };
}
