# Channels pinned messages — September 29

Release `f85233b8f4194edd94510d63988a5f6f095686dc` is pushed and active on both development web nodes and compatibility. Worker and production were not changed.

Pinned messages have a warm background, accent border and pin label in conversations, threads and the Pins tab, with matching treatment in the pinned-message panel. The empty Pins tab and panel say: “Easy access to all of your most important messages. Right-click on a message to pin it to the channel.”

Right-click opens the existing message action menu, including Pin to channel / Unpin. Shift+F10 and the context-menu key also work; links, media, editors and selected text retain their native context menus. Pin changes preserve conversation scroll position and refresh visible pin collections, including after unpinning the last message. Existing server authorization remains unchanged.

Local and dev-served browser checks passed for right-click pinning, keyboard unpinning, pinned styling, the exact empty text and immediate removal from Pins. The full isolated composer regression also passed. Screenshots were reviewed. The browser uses fake APIs/media and does not pin actual user messages. JavaScript syntax and diff checks passed.

The release inherits each node's complete predecessor runtime and overlays only the Channels UI and bundle manifest. All three roles passed source hashes, readiness and development isolation checks; two public assets and six public readiness responses matched. Rollback predecessor for all three is `939eacc60e0215013d706a24beb3638d59fa785c`. Check for intervening releases, use the existing atomic symlink/service workflow, and verify public return before moving to the next web node. Evidence is under ignored `output/channels-pins-20260929/`. No database migration was needed; the existing autoscale replacement-image limitation remains.
