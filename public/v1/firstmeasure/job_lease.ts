// The queue is at-least-once, not exactly-once. Losing a lease must stop the
// process before it continues external side effects alongside a replacement.
export async function runWithJobLease<T>(options: {
  execute: () => Promise<T>;
  renew: () => Promise<boolean>;
  leaseUntilMs: number;
  leaseMs: number;
  intervalMs: number;
  safetyMarginMs: number;
  maxRuntimeMs: number;
  fatal: (reason: string) => void;
  warn: (error: unknown) => void;
}): Promise<T> {
  let leaseUntil = options.leaseUntilMs;
  let pending = false;
  let finished = false;
  const started = Date.now();
  let timer: ReturnType<typeof setInterval>;
  const failure = new Promise<never>((_, reject) => {
    const fatal = (reason: string) => {
      if (finished) return;
      finished = true;
      reject(new Error(reason));
      options.fatal(reason);
    };
    timer = setInterval(() => {
      if (finished) return;
      const now = Date.now();
      if (now >= leaseUntil - options.safetyMarginMs) {
        fatal('Cannot confirm job lease ownership before expiry.');
        return;
      }
      if (now - started >= options.maxRuntimeMs) {
        fatal('Job exceeded the maximum runtime.');
        return;
      }
      if (pending) return;
      pending = true;
      const renewalStarted = Date.now();
      void options.renew().then((owned) => {
        if (finished) return;
        if (!owned) fatal('Job lease ownership was lost.');
        else leaseUntil = renewalStarted + options.leaseMs;
      }).catch(options.warn).finally(() => { pending = false; });
    }, options.intervalMs);
  });
  try { return await Promise.race([Promise.resolve().then(options.execute), failure]); }
  finally { finished = true; clearInterval(timer!); }
}
