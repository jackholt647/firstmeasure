# Custom-field scope order and adaptive placement — September 26, 2026

Follow-up to the custom-field UI redesign. Tabs are Projects, Contacts, Organization, with Projects selected by default. Placement settings explicitly name Project details or Contact details and update when Used on changes. Organization fields do not offer record-details placement; their section is named Field behavior.

Source: `9aa7d682b95f2f2b2c886c8d255f19215659e92a` (`codex/custom-fields-scopes`). Seven browser/UI tests passed, including scope order/default and adaptive labels/visibility.

| Role | Previous release | Release |
| --- | --- | --- |
| web | `4950c7556d60cf77a096f9578738683e4f304a1f` | `c3abb2eaf90cf3c2f34fdec3bdbb8296b0cdf920` |
| pool | `4950c7556d60cf77a096f9578738683e4f304a1f` | `2a6178f5644aebe384191d83d3a0f667b082d009` |

Both roles passed activation, readiness and source-hash checks. A concurrent rollout subsequently replaced the release directories; its current releases preserve the exact custom-field asset hash. Public readiness and the served asset passed after that rollout completed. Only the browser custom-field asset changes; existing role source was preserved with three-way merges. Evidence: `output/custom-fields-scopes/`.

Verified successor web: `5d33748d9b2917ef1d5b09c4bf176c7d9418ee10`.

Verified successor pool: `2e96982353976a9606858b3a292b544780d084b0`.
