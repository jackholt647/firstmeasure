# Test Company capability reset — September 24, 2026

Development Test Company (`3dbf7f79528139e27c491363`, the `notifications@1m8.ai` test account) was restored to the capability registry defaults, with these explicit enabled exceptions:

- `mobile.app_download` and `mobile.developer_downloads` for the private development app build
- `firstmeasure.exteriors` for Full House exterior reports
- `firstmeasure.report_localization` for language and unit controls
- `firstmeasure.metric_measurements` for metric report defaults

The previous global document had 33 enabled deviations from registry defaults, including `platform.expanded_access` and unrelated platform apps. Its flags were backed up on the development web node at `/tmp/firstmeasure-test-company-flags-before-revision-116.json`, then replaced through the platform's atomic global-document mutation. The document advanced from revision 116 to 117. The selected-user rollout configuration was left as stored; it has no effect while expanded platform access is off.

Read-only audits from both serving development web nodes found exactly those five enabled deviations and verified they are effective. Commercial and multifamily Full House flags remain off. No application release, production data, or other organization was changed.
