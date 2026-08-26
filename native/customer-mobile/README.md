# FirstMate Customer Mobile Capacitor Shell

This is an isolated first-pass Capacitor wrapper for the customer-side mobile app.

It does not replace or modify the desktop portal. During local Android emulator testing it opens:

```text
http://127.0.0.1:8021/apps/customer-mobile/
```

That route logs in through `PlatformAPI.auth` and then hands off to the existing `/portal/mobile/` customer UI.

## Local Setup

Fast path:

```powershell
.\Launch-Customer-Mobile-Android.bat
```

That starts/checks the local stack, boots the Android emulator, forwards localhost ports, builds the debug APK, installs it, and launches the app.

From this folder:

```powershell
npm.cmd install
npm.cmd run cap:sync
```

Start the repo local NGINX/API stack from the repository root:

```powershell
.\start-nginx-local.ps1
```

Forward emulator localhost ports to the host:

```powershell
adb reverse tcp:8021 tcp:8021
adb reverse tcp:3111 tcp:3111
```

Then run Android:

```powershell
npm.cmd run android
```

## Notes

- `CAP_SERVER_URL` can override the dev server URL.
- For production app-store builds, remove the dev `server.url` behavior and bundle or host a production customer-mobile URL intentionally.
- Native camera, push notifications, and offline storage are not wired yet. The dependencies are included so the next pass can add the bridges without changing the project shape.
