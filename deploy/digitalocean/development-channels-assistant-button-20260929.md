# Remove new assistant conversation button — September 29

Release `f973fc17bf8a6a5cb2c145212a6844371bc1fd1b` removes the New assistant conversation action and its creation dialog from the Channels header. It is pushed and active on both development web nodes and compatibility. Worker and production are unchanged.

JavaScript syntax and diff checks passed. The immutable release overlays only the shared Channels UI and bundle manifest on verified predecessors. All three updated roles passed source hashes, readiness and development-isolation checks; two public asset hashes and six public readiness responses matched. No backend, package or database change was needed.

Rollback predecessor for all three updated roles is `36544d9d7ae8630b5d8a5ed2fd1f7cd42263864c`. Check for intervening releases before rollback and use the existing atomic symlink/service workflow with public readiness verification. Evidence is under ignored `output/channels-assistant-button-20260929/`. The existing autoscale replacement-image limitation remains.
