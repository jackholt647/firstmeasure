import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const library = await readFile(path.join(publicRoot, 'libraries/insights/firstmate-insights.js'), 'utf8');
const css = await readFile(path.join(publicRoot, 'libraries/insights/firstmate-insights.css'), 'utf8');
const company = await readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8');
const feedback = await readFile(path.join(publicRoot, 'libraries/apps/settings/feedback.js'), 'utf8');
const search = await readFile(path.join(publicRoot, 'libraries/apps/settings/search.js'), 'utf8');
const portal = await readFile(path.join(publicRoot, 'portal/index.php'), 'utf8');
const definition = await readFile(path.join(publicRoot, 'v1/insights/definition.ts'), 'utf8');
const icon = path.join(publicRoot, 'libraries/insights/assets/insights.png');

test('Insights is a reusable global library with the supplied optimized icon', async () => {
  await access(icon);
  assert.ok((await stat(icon)).size < 100_000, 'runtime icon should be optimized for repeated UI use');
  assert.match(portal, /libraries\/insights\/firstmate-insights\.js/);
  for (const method of ['configure', 'register', 'create', 'mount', 'scan', 'mountSettings', 'loadPreferences', 'savePreferences']) {
    assert.match(library, new RegExp(`\\b${method}\\b`));
  }
  assert.match(library, /root\.FirstMateInsights = api/);
  assert.match(library, /assets\/insights\.png/);
  assert.match(library, /--fm-insight-icon/);
  assert.match(css, /\.fm-insight-logo:after\{[^}]*background:var\(--primary,#d93025\)/);
  assert.match(css, /mix-blend-mode:color/);
  assert.match(css, /mask:var\(--fm-insight-icon/);
});

test('popover behavior covers top-layer rendering, chrome-aware placement, and dismissal paths', () => {
  assert.match(library, /function bestSide\(rect, width, height, preferred, bounds\)/);
  assert.match(library, /const order = \['bottom','top','right','left'\]/);
  assert.match(library, /function usableViewport\(\)/);
  assert.match(library, /#platformTopbar/);
  assert.match(library, /bounds\.top\+margin/);
  assert.match(library, /showPopover/);
  assert.match(library, /requestedMaxHeight > 0 \? requestedMaxHeight : 560/);
  assert.match(library, /<header class="fm-insight-head".*<div class="fm-insight-scroll"><div class="fm-insight-conversation">/);
  assert.match(library, /document\.addEventListener\('pointerdown', onOutside, true\)/);
  assert.match(library, /event\.key === 'Escape'/);
  assert.match(css, /rotate\(45deg\)/);
  assert.match(css, /\.fm-insight-popover\.open/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /z-index:2147483647!important/);
  assert.match(css, /font-family:Montserrat,"Montserrat",Arial,sans-serif/);
  assert.match(css, /max-height:min\(560px/);
  assert.match(css, /\.fm-insight-scroll\{[^}]*overflow:auto/);
  assert.match(css, /\.fm-insight-head\{[^}]*flex:0 0 auto/);
  assert.match(css, /\.fm-insight-composer\{[^}]*flex:0 0 auto/);
});

test('Configuration includes customer-only Insights and agent controls', () => {
  assert.match(company, /\{ id:'insights', label:'Insights' \}/);
  assert.match(company, /data-configuration-pane="insights"/);
  assert.match(company, /FirstMateInsights\.mountSettings/);
  assert.match(company, /insights: null/);
  assert.match(search, /title:'Insights', view:'insights'/);
  assert.match(library, /data-insights-enabled/);
  assert.match(library, /data-insights-agent/);
  assert.match(library, /developerContext/);
});

test('inline conversations use the centralized read-only Insights agent', () => {
  assert.match(library, /AgentsAPI\.createThread/);
  assert.match(library, /AgentsAPI\.send/);
  assert.match(library, /developer_context/);
  assert.match(definition, /id: INSIGHTS_AGENT_ID/);
  assert.match(definition, /name: "read_insight_context"/);
  assert.doesNotMatch(definition, /permission:/);
  assert.match(definition, /This agent is explanatory and read-only/);
  assert.match(definition, /hidden developer context/i);
  assert.match(definition, /do not reflexively apologize/);
});

test('Feedback delivery uses the shared Insight recommendation', () => {
  assert.match(feedback, /data-feedback-timing-insight/);
  assert.match(feedback, /FirstMateInsights\.mount\(timingInsightHost/);
  assert.match(feedback, /id:'feedback_delivery_timing_recommendation'/);
  assert.match(feedback, /We recommend automatically sending the feedback request to all customers, even if the job did not go that well/);
  assert.match(feedback, /preferredSide:'left'/);
  assert.match(feedback, /deliveryTimingInsight\?\.destroy\?\.\(\)/);
});
