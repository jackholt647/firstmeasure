# Customer Mobile App Wrapper

This is the standalone customer mobile entry point intended for native app shells.

Current first-pass behavior:

- Authenticates with `PlatformAPI.auth.*`.
- Reuses the existing `/portal/mobile/` customer app after login.
- Leaves the desktop portal and PHP-authenticated `/portal/mobile/` implementation unchanged.

URL for browser testing:

```text
/apps/customer-mobile/
```

For Capacitor emulator testing, the native wrapper points at this route on the local dev server.

