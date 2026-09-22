import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const proposalSource = await readFile(path.join(publicRoot, 'libraries/apps/proposals/project.js'), 'utf8');
const photoFeedSource = await readFile(path.join(publicRoot, 'libraries/apps/photos/feed.js'), 'utf8');
const projectPhotosSource = await readFile(path.join(publicRoot, 'libraries/apps/photos/project.js'), 'utf8');
const proposalStyles = await readFile(path.join(publicRoot, 'libraries/apps/project-request/app.js'), 'utf8');
const customerPortalSource = await readFile(path.join(publicRoot, 'customer_portal/customer_portal.js'), 'utf8');
const pdfSource = await readFile(path.join(publicRoot, 'v1/proposals/pdf.ts'), 'utf8');

test('proposal media pickers accept both images and videos', () => {
  const picker = proposalSource.match(/function openProposalPhotoPicker[\s\S]*?function handleProposalPreviewKeydown/)?.[0] || '';
  assert.match(picker, /imageOnly: false/);
  assert.match(picker, /accept="image\/\*,video\/\*"/);
  assert.match(picker, /Select Cover Media/);
  assert.match(picker, /Select Project Media/);
  assert.match(photoFeedSource, /const uploadAccept = options\.accept \|\| \(imageOnly \? 'image\/\*' : 'image\/\*,video\/\*'\)/);
  assert.match(photoFeedSource, /data-picker-file accept="\$\{escapeHtml\(uploadAccept\)\}"/);
  assert.match(photoFeedSource, /imageOnly \? `photo\$\{count === 1 \? '' : 's'\}` : `media item\$\{count === 1 \? '' : 's'\}`/);
});

test('processing media remains selectable and resolves to its durable media id', () => {
  assert.doesNotMatch(photoFeedSource, /That image is still processing/);
  assert.match(photoFeedSource, /fm:project-media-upload-started/);
  assert.match(photoFeedSource, /selected\.delete\(placeholderId\)/);
  assert.match(projectPhotosSource, /fm:project-media-upload-resolved/);
  assert.match(projectPhotosSource, /\.\.\.serverPhotos, \.\.\.completed, \.\.\.pending/);
  assert.match(proposalSource, /function replaceResolvedProposalMedia/);
  assert.match(proposalSource, /r-proposal-media-processing/);
});

test('proposal picker refreshes from project-owned media inventory', () => {
  assert.match(projectPhotosSource, /async function loadOwnedProjectMedia/);
  assert.match(projectPhotosSource, /\.filter\(\(item\) => ownedMediaProjectId\(item\) === projectId\)/);
  assert.match(proposalSource, /invoke\?\.\('loadOwnedProjectMedia'\)/);
});

test('proposal media renders controlled inline video without eager autoplay', () => {
  const renderer = proposalSource.match(/function proposalMediaVisualHtml[\s\S]*?function bindProposalVideoPlayback/)?.[0] || '';
  assert.match(renderer, /data-proposal-video="true"/);
  assert.match(renderer, /controls playsinline preload="metadata"/);
  assert.doesNotMatch(renderer, /\sautoplay(?:\s|>)/);
  assert.match(renderer, /r-proposal-video-print-thumbnail/);
  assert.match(renderer, /r-proposal-video-print-fallback/);
  assert.match(proposalStyles, /r-proposal-video-player/);
});

test('editor and customer portal autoplay once only after full visibility', () => {
  const editorPlayback = proposalSource.match(/function bindProposalVideoPlayback[\s\S]*?function proposalPageSubtitle/)?.[0] || '';
  assert.match(editorPlayback, /intersectionRatio < 0\.999/);
  assert.match(editorPlayback, /proposalAutoPlayedVideoKeys\.has/);
  assert.match(editorPlayback, /video\.muted = true/);
  assert.match(editorPlayback, /video\.play\(\)/);

  const portalPlayback = customerPortalSource.match(/function bindDocumentProposalVideoPlayback[\s\S]*?function syncDocumentFrameScale/)?.[0] || '';
  assert.match(portalPlayback, /left >= 0 && top >= 0 && right <= viewportWidth && bottom <= viewportHeight/);
  assert.match(portalPlayback, /proposalDocumentAutoPlayedVideoKeys\.has/);
  assert.match(portalPlayback, /video\.muted = true/);
  assert.match(portalPlayback, /video\.play\(\)/);
});

test('PDF generation waits for first-frame thumbnail fallbacks', () => {
  assert.match(pdfSource, /video\.r-proposal-video-print-fallback/);
  assert.match(pdfSource, /loadeddata/);
  assert.match(pdfSource, /video\.currentTime/);
  assert.match(proposalSource, /r-proposal-pdf-doc \.r-proposal-video-player\{display:none!important\}/);
});
