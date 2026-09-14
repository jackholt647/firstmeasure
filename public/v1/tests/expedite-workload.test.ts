import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportExpediteOptions } from '../firstmeasure/expedite.js';
import { DEFAULT_EXPEDITE_PRICING, pricingContext } from '../firstmeasure/pricing_config.js';

function quote(config: typeof DEFAULT_EXPEDITE_PRICING, at: string, structureCount = 1) {
  return pricingContext.run({config,revision:7,now:new Date(at)},()=>buildReportExpediteOptions({projectType:'commercial',structureCount}));
}

test('custom peak, schedule and eight-hour cap affect estimates and pricing together', () => {
  const config = {...DEFAULT_EXPEDITE_PRICING,workload_peak_minutes:440,turnaround_max_minutes:500,
    ramp_start_minute:480,peak_start_minute:600,peak_end_minute:840,ramp_end_minute:1080};
  const night=quote(config,'2026-09-14T08:00:00Z');
  const peak=quote(config,'2026-09-14T19:00:00Z');
  assert.equal(night.options[0]!.estimated_wait_minutes,240);
  assert.ok(peak.options[0]!.estimated_wait_minutes! >= 480);
  assert.ok(peak.options[1]!.unit_price > night.options[1]!.unit_price);
  const flat={...config,workload_base_minutes:420,workload_peak_minutes:420,turnaround_max_minutes:480};
  for(let hour=0;hour<24;hour++){
    const q=quote(flat,`2026-09-14T${String(hour).padStart(2,'0')}:00:00Z`);
    assert.equal(q.options[0]!.estimated_wait_minutes,480);
    assert.equal(q.options[0]!.base_end_minutes,480);
    assert.equal(q.options[0]!.label,'8-8 hrs');
    assert.equal(q.options[1]!.end_minutes,60);
    assert.equal(q.options[2]!.end_minutes,180);
  }
  const multi=quote(flat,'2026-09-14T19:00:00Z',3).options[0]!;
  assert.equal(multi.estimated_wait_minutes,540,'commercial structures retain 30-minute increments');
  assert.equal(Date.parse(multi.due_window_end!)-Date.parse('2026-09-14T19:00:00Z'),540*60000);
});

test('Pacific schedule follows daylight saving and configurable boundaries', () => {
  const config={...DEFAULT_EXPEDITE_PRICING,workload_peak_minutes:400,turnaround_max_minutes:480,
    ramp_start_minute:300,peak_start_minute:360,peak_end_minute:420,ramp_end_minute:480};
  for(const at of ['2026-09-14T13:30:00Z','2026-01-14T14:30:00Z']){
    assert.ok(quote(config,at).options[0]!.estimated_wait_minutes! > 400,'06:30 Pacific is peak in both seasons');
  }
  assert.equal(quote(config,'2026-09-14T15:00:00Z').options[0]!.estimated_wait_minutes,240,'wind-down endpoint returns to baseline');
});
