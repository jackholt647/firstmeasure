import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const companySettingsUrl = new URL('../../libraries/apps/settings/company.js', import.meta.url);

test('salary compensation requires an explicit, persisted period', async () => {
  const source = await readFile(companySettingsUrl, 'utf8');

  assert.match(source, /\['week', 'Weekly'\]/);
  assert.match(source, /\['biweekly', 'Every two weeks'\]/);
  assert.match(source, /\['semimonthly', 'Twice monthly'\]/);
  assert.match(source, /\['month', 'Monthly'\]/);
  assert.match(source, /\['year', 'Annually'\]/);
  assert.match(source, /id="cuNewCompSalaryPeriod"/);
  assert.match(source, /id="cuEditCompSalaryPeriod"/);
  assert.match(source, /data-comp-salary-period/);
  assert.match(source, /salary_period:normalizeSalaryPeriod\(m\.el\.querySelector\('#cuNewCompSalaryPeriod'\)/);
  assert.match(source, /salary_period:normalizeSalaryPeriod\(m\.el\.querySelector\('#cuEditCompSalaryPeriod'\)/);
  assert.doesNotMatch(source, /Salary \/ week/);
  assert.doesNotMatch(source, /salary_period:'week'/);
});
