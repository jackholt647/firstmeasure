# FirstMate Management Mobile

Native Android/iOS shell for the existing FirstMate management portal.

The app loads the local web wrapper at:

```text
http://127.0.0.1:8021/apps/management-mobile/
```

That wrapper signs into the shared Platform API and then hands off to
`/portal/`, which is the existing PHP management dashboard.

For local Android testing, double-click:

```text
Launch-FirstMate-Management-Android.bat
```

