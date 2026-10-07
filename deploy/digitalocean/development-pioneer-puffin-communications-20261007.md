# Pioneer Puffin communications examples — October 7, 2026

The newest Pioneer Puffin Test Co sandbox (`org_983c8e17cd313149`) on
`dev.1m8.ai` now has realistic retained communication history. The data seed is
[`seed-pioneer-puffin-communications.mjs`](../../public/v1/scripts/seed-pioneer-puffin-communications.mjs).
It ran against the existing development service configuration without changing
the application release or production data.

The seed added seven project-linked customer conversations with 43 messages
across email, SMS and portal chat, five external-phone call records with
outcomes and notes, and 23 captured
outbound delivery records. It also extended the three original one-sided
sample email threads with nine replies and replaced their generic subjects.
Across both steps, 52 new messages are evenly split between customer and staff.
The records use fictional sample contacts and reserved `.test` email addresses
and 555 phone numbers. Email and SMS outbound entries are capture-mode history;
portal chat messages are retained in-app. No email, SMS, phone call, provider
job, or customer notification was sent.

Verification through the public authenticated Communications API found all 52
seeded messages, the 26/26 direction split, five calls, and no remaining generic
sample subject. In the hosted browser, the text and email threads showed both
sides of the conversation; the Chats filter showed the portal thread; History showed the calls, and a call detail showed
its saved note. No page errors occurred. A repeat seed created zero records.
Screenshots and verification scripts are under the ignored
`output/communications-20261007` directory.
