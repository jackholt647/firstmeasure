# Development trim inches — September 18, 2026

Runtime `957a20c52f04bfdece4df9e3e770da223601dfc5`; baseline `8d5ae5d37e2e53c72c9528b69632b3f7661d0912`.

Typed width for the T trim tool now uses inches (0.0254 m per input unit). The shared distance badge displays in for this owner; other distance owners remain in feet and angles retain degrees.

280 editor tests pass. A direct keyboard/badge check verifies that 6 means 6 inches for trim and 2 still means 2 feet for an ordinary distance owner. Root source matches the isolated release after baseline checks.

The guarded two-file delta preserves other development files and verifies readiness and isolation on all three roles. Production is unchanged. Refresh the editor before using the updated input.
