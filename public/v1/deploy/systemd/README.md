# FirstMeasure background-worker deployment

The HTTP service and FirstMeasure background processing must run as separate
systemd services. This prevents an HTTP cluster worker exit from removing PDF,
email, scheduled-release, refund, and stale-claim processing.

After all uploaded files are complete, run this one command:

```bash
cd /var/www/ide/v1 && sudo bash deploy/systemd/deploy-firstmeasure-worker.sh
```

The script discovers the existing service User and Group, compiles while the
current HTTP service remains online, installs both systemd configurations,
starts the worker, performs the short HTTP restart, and verifies HTTP plus the
shared worker heartbeat. No separate database migration is required.

The release-hold timer remains as a reconciliation sweep, but every newly held
report also receives a durable `report.release` job with an availability time.
Leases and retries allow the worker service to resume the job after a crash.
