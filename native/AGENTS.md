# Core FirstMate app

- `firstmate/` is the sole canonical Android/iOS app, owned by the global platform.
- Extend this host and the shared portal for new modules; do not create separate
  customer, management, or FirstMeasure apps without an explicit product request.
- Preserve installed `ai.firstmeasure.mobile` identifiers and version-1 bridge
  transport names. These are compatibility identifiers, not app ownership.
- Read `firstmate/README.md` for build, push, signing, and verification instructions.
- Historical deployment/import records may mention removed prototypes or the old
  directory name; they are not current implementation instructions.
