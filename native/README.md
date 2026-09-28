# FirstMate mobile infrastructure

[`firstmate/`](firstmate/README.md) is the only supported mobile application:
the global **FirstMate** platform host for Android and iOS. It loads the shared
portal and supports all enabled platform modules, including Measurements.
Development and production are configurations of this same app.

The former customer and management Capacitor prototypes and their web wrappers
were removed. Do not restore them from historical import or deployment records.
No module-specific or audience-specific mobile spinoffs are currently maintained.

Shared web/native capabilities live in `public/libraries/phone-features`;
mobile authentication and app downloads live in `public/v1/mobile`;
notifications use the shared platform notification service and settings.
