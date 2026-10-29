"""Runs on the production worker: wait for no running jobs, then activate c144dd1b."""
import subprocess, pathlib, time
pid = subprocess.check_output(["systemctl", "show", "firstmeasure-worker", "-p", "MainPID", "--value"], text=True).strip()
env = dict(i.split("=", 1) for i in pathlib.Path("/proc", pid, "environ").read_text().split("\0") if "=" in i)
js = 'const {queryPostgres}=await import("./dist/src/database/postgres.js");const r=await queryPostgres("SELECT count(*)::int n FROM firstmeasure_jobs WHERE status=\'running\'");console.log(r.rows[0].n);process.exit(0);'
for i in range(60):
    n = int(subprocess.run(["node", "--input-type=module", "-e", js], cwd="/opt/firstmeasure/current/public/v1", env=env, capture_output=True, text=True, timeout=60).stdout.strip().splitlines()[-1])
    if n == 0:
        print(time.strftime("%H:%M:%S"), "no running jobs"); break
    time.sleep(5)
else:
    print("jobs still running"); raise SystemExit(3)
R = "ef3f183f602553940d01b09fe7f6c04da16e5c7d"
assert pathlib.Path("/opt/firstmeasure/current").resolve().name == "3d1fdb127507247b2bdb73b0cdf29f72aac1af29"
t = time.time()
r = subprocess.run(["bash", "/opt/firstmeasure/releases/" + R + "/deploy/digitalocean/activate-release.sh", R, "firstmeasure-worker.service"], capture_output=True, text=True, timeout=400)
print("exit", r.returncode, "seconds", round(time.time() - t), r.stdout.strip().splitlines()[-1:] if r.stdout else r.stderr[-500:])
pid = subprocess.check_output(["systemctl", "show", "firstmeasure-worker", "-p", "MainPID", "--value"], text=True).strip()
e = dict(i.split("=", 1) for i in pathlib.Path("/proc", pid, "environ").read_text().split("\0") if "=" in i)
print({k: e.get(k) for k in ["RELEASE_ID", "FIRSTMEASURE_JOB_WORKERS", "PLATFORM_HEARTBEAT_DISABLED", "FIRSTMEASURE_DATA_ENVIRONMENT", "EMAIL_OUTBOUND_DISABLED"]})
