import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { env } from '../src/config/env.js';
import { fullHouseContext, fullHouseEnabled, isFullHouseId } from '../firstmeasure/full_house.js';
import { getProjectDetail, readArtifact } from '../firstmeasure/storage.js';
import { readInternalUser } from './storage.js';
import { forbidden } from '../platform/errors.js';

// The PHP session bridge signs the complete request, not a browser-supplied actor.
export async function tutorialBridgeActor(request: FastifyRequest) {
  const email = String(request.headers['x-tutorial-user'] || '').trim().toLowerCase();
  const time = String(request.headers['x-tutorial-time'] || '');
  const signature = String(request.headers['x-tutorial-signature'] || '');
  const secret = process.env.STAFF_TRACKING_BRIDGE_SECRET || env.firstMeasureInternalApiSecret;
  const expected = createHmac('sha256', secret || '')
    .update(`${email}\n${time}\n${JSON.stringify(request.body ?? {})}`).digest('hex');
  if (!secret || !email || !/^\d{10}$/.test(time)
    || Math.abs(Date.now() / 1000 - Number(time)) > 180 || !/^[a-f0-9]{64}$/.test(signature)
    || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw forbidden('invalid_tutorial_bridge', 'Invalid training request.');
  const user = await readInternalUser(email);
  if (!user || user.disabled === true || !['active', 'enabled'].includes(String(user.status ?? 'active').toLowerCase())) throw forbidden('inactive_staff', 'Active staff access required.');
  return { ...user, email };
}

// Only call after checking a curriculum assignment or instructor permission.
export async function withTutorialSource<T>(source: string, work: () => Promise<T>): Promise<T> {
  if (isFullHouseId(source) && !fullHouseEnabled()) throw forbidden('exteriors_disabled', 'Exterior training is not enabled in this environment.');
  const context = fullHouseContext.getStore();
  return context ? fullHouseContext.run({ ...context, allowed: true }, work) : work();
}

export function tutorialSourceFile(name: string) {
  // Never expose the answer geometry, report snapshots, generated PDFs or source markups.
  return /^(google\.(png|jpg)|rgb\.tif|dsm\.tif|mask\.tif|insights\.json|internal-resource-[a-zA-Z0-9._-]+|internal-markup-part-[a-zA-Z0-9._-]+)$/.test(name);
}

export async function exteriorTrainingCapability(source: string, detail?: Awaited<ReturnType<typeof getProjectDetail>>) {
  const bundle = detail ?? await getProjectDetail(source);
  const names = new Map(bundle.files.map(file => [file.name, file.size]));
  const sides = new Set<string>();
  for (const file of bundle.files) {
    if (!/^internal-resource-.*\.(jpg|jpeg|png|webp|avif|gif)$/i.test(file.name)) continue;
    if (file.name.startsWith('internal-resource-v2-')) {
      try {
        const index = JSON.parse((await readArtifact(source, file.name)).content.toString('utf8'));
        const complete = index.format === 'firstmeasure-resource-chunks-v1' && index.size > 0 && index.parts > 0
          && index.parts === Math.ceil(index.size / (8 * 1024 * 1024))
          && Array.from({ length: index.parts }, (_, part) => part).every(part =>
            names.get(`internal-markup-part-${index.id}-${String(part).padStart(8, '0')}.bin`) === Math.min(8 * 1024 * 1024, index.size - part * 8 * 1024 * 1024));
        if (complete && ['front','back','left','right'].includes(index.elevation_view)) sides.add(index.elevation_view);
      } catch { /* A broken or unfinished upload is not usable reference data. */ }
    }
  }
  const missing = ['front','back','left','right'].filter(side => !sides.has(side));
  if (!(names.get('dsm.tif')! > 0)) missing.push('height map');
  if (!['google.png','google.jpg','rgb.tif'].some(name => names.get(name)! > 0)) missing.push('roof imagery');
  return { available: missing.length === 0, missing, measurement_scope: missing.length ? 'roof' : 'full_house' };
}
