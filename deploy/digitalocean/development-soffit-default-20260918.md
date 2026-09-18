# Development soffit default — September 18, 2026

Runtime `03616a26140b9013e34f28ca2046e79d69d013ae`; baseline `06b984f518dc4b17bed771a400289648a8f35dfb`.

From Roof Auto now uses 24 inches (2 ft), and its menu label reflects that value. Explicit presets and saved project options remain intact. Legacy geometry inference is unchanged.

All 53 wall-mode tests pass, including Auto matching explicit 24 inches and regeneration at every preset. The historical 18-inch overlap fixture explicitly selects its original preset. Root and release runtime source match. The localhost preview server was stopped during verification.

Only wall_mode.js is included in the guarded development delta. Deployment preserves the other 18,100 public files on each role and verifies development isolation and release readiness. Production is unchanged.
