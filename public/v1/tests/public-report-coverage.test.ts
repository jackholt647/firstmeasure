import assert from 'node:assert/strict';
import test from 'node:test';
import { publicReportSummary } from '../public-firstmeasure/reports.js';

const record:any={report_id:'fixture',org_id:'org',mode:'live',amount_charged:10,created_at:'2026-09-14',updated_at:'2026-09-14',metadata:{}};
test('public API retains coverage rejection status and customer-facing reason/message',()=>{
 const report=publicReportSummary(record,{manifest:{status:'rejected_no_coverage',rejection_reason:'no_height_map',customer_rejection_message:'No usable height imagery at the requested structures.',email_state:{rejection_email:{sent_ok:true}}}});
 assert.equal(report.status,'rejected_no_coverage');assert.equal(report.rejection?.reason,'no_height_map');
 assert.equal(report.rejection?.message,'No usable height imagery at the requested structures.');assert.equal(report.rejection?.email.sent,true);
});
test('legacy coverage rejection cannot disappear when reason or message is absent',()=>{
 const report=publicReportSummary(record,{manifest:{status:'rejected_no_coverage'}});
 assert.equal(report.rejection?.reason,'no_coverage');assert.ok(report.rejection?.message);assert.equal(report.rejection?.email.sent,false);
});
test('pending coverage review is not exposed as rejection; explicit messages retain priority',()=>{
 assert.equal(publicReportSummary(record,{manifest:{status:'needs_coverage_review',structure_pin_error:'Provider coverage check failed'}}).rejection,null);
 const report=publicReportSummary(record,{manifest:{status:'rejected',rejection_reason:'other',rejection_message:'Explicit message',customer_rejection_message:'Fallback'}});
 assert.equal(report.rejection?.message,'Explicit message');assert.equal(report.rejection?.reason,'other');
});
