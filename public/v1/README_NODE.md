# v1 Node Host

This is the shared Node host for modular `/v1/*` APIs.

## Current Mounted APIs

- `/v1/firstmeasure`

## Purpose

Each API can keep its own code in its own folder, while this host is the thin routing layer that mounts them under `/v1/<name>`.

## Commands

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run check
npm.cmd run build
```

## Production Concurrency

`npm start` runs the compiled server in HTTP cluster mode by default. It starts up to 8 Fastify worker processes automatically, so normal `/v1/*` requests can spread across CPUs without overcommitting memory.

Set `V1_WEB_WORKERS` to tune this:

```powershell
$env:V1_WEB_WORKERS = "8"
npm.cmd start
```

Use `V1_WEB_WORKERS=0` or `1` for a single HTTP process. `FIRSTMEASURE_JOB_WORKERS` is separate; it controls the FirstMeasure background job queue, not HTTP request concurrency.

## Local Test URLs

- `http://127.0.0.1:3101/v1`
- `http://127.0.0.1:3101/v1/firstmeasure/ping`
- `http://127.0.0.1:3101/v1/firstmeasure/echo`
- `http://127.0.0.1:3101/v1/test-client.html`
