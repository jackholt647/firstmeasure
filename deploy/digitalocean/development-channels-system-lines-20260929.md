# Gray channel membership notices — September 29

Release `70769784deef7b1147203105fd42469d6648ba7d` is pushed and active on both development web nodes and compatibility. Worker and production are unchanged.

System activity such as member-added and member-joined notices now renders as a compact gray text line without an avatar, author heading or message actions. Existing system records use the new display automatically. Ordinary messages retain their normal presentation, even if someone types the same words. Huddle notices retain their interactive call controls.

JavaScript syntax and diff checks passed. An isolated browser harness passed locally and against dev-served assets for gray color, no avatar/author controls, member addition/join notices, normal messages and retained huddle controls. A screenshot was reviewed. Tests use fake APIs and do not modify real channel membership.

The immutable release overlays only the shared Channels UI and bundle manifest. All updated roles passed source hashes, readiness and development-isolation checks; two public asset hashes and six public readiness responses matched. No backend or database change was needed.

Rollback predecessor for all three updated roles is `34ea50ad7addf8af6656fbca60b944d093c236f9`. Check for intervening releases and use the existing atomic symlink/service workflow with public readiness verification. Evidence is under ignored `output/channels-system-lines-20260929/`. The existing autoscale replacement-image limitation remains.
