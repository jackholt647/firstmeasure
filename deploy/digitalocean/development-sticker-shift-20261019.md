# Sticker typing with Shift — development, October 19, 2026

Source `180c64a04414452d6622f58ded2336f591f8d718`. Typing a selected face as a window, door or garage door is now
Shift+W, Shift+D or Shift+G. It was Ctrl/Cmd, which the browser reserves: Ctrl+W closes the tab. Plain W/D/G still
start placement, or retype a selected sticker. Ctrl+W/D/G is no longer consumed by the editor. The wall panel hint was
updated, and `dev/wall-face-draft.test.cjs` covers both shortcuts (513 tests pass).

The rollout overlaid `wall_face_draft.js` and `wall_mode.js` onto `700b8d54` on the web, legacy and pool roles. All
three roles verified, and the files served from `dev.1m8.ai` match. The worker and production were not changed.
