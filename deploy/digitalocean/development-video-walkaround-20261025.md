# Order workflow: "video walkaround" instead of "orbital video" — development, October 25, 2026

Release `9d833486`.

- **Customers.** Every customer-facing "orbital video" in the Full Exterior order flow now says "video walkaround",
  under new catalog keys: the intro, the recorder, the switch links, the summary, the upload status and the order
  blockers.
- **Server.** Its order refusals say it too (`firstmeasure/exteriors.ts`), and so do reference video file names
  (`Structure 1 · video walkaround`, `firstmeasure/api.ts`).
- **Unchanged.** The stored reference view `orbital_video` and code names stay.
- **Tests.** `exteriors-orbital-video` passes 9/9; its summary check now expects "Video walkaround" and had been
  failing before. `exteriors-guided-camera`, `exteriors-order` and `exteriors-photo-workflow` pass, except the pin
  confirmation case, which was already failing.
- **Rollout.** Worker, legacy and web. The first stage met another session's activation; the script waited,
  re-audited on `5ee7eceb` and finished. Verify passed, and dev serves the new text. Scripts:
  `output/fh-walkaround-20261025/`.
- **Production.** Not on production.
