import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getFirstMeasureJobRuntimeStatus } from "../firstmeasure/job_runtime.js";

const execute = promisify(execFile);

// systemd is outside Node: it can recover an event-loop stall that an in-process
// timer cannot. No watchdog is assumed on local Windows/macOS development.
export async function startWorkerSupervision() {
  if (!process.env.NOTIFY_SOCKET) return () => {};
  const notify = (...args: string[]) => execute("/usr/bin/systemd-notify", [`--pid=${process.pid}`, ...args], { timeout: 5_000 });
  await notify("--ready", "--status=Background worker ready; monitoring database heartbeat.");
  let pending = false;
  const timer = setInterval(() => {
    const state = getFirstMeasureJobRuntimeStatus();
    const heartbeatAge = Date.now() - Date.parse(state.heartbeatAt);
    // Do not conceal a dead DB connection with an otherwise responsive process.
    if (pending || state.workerCount <= 0 || !Number.isFinite(heartbeatAge) || heartbeatAge > 90_000) return;
    pending = true;
    void notify("WATCHDOG=1").catch((error) => {
      console.error("Worker watchdog notification failed", error.message);
    }).finally(() => { pending = false; });
  }, 20_000);
  timer.unref();
  return () => clearInterval(timer);
}
