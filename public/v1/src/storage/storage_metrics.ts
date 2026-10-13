const counters = new Map<string, { count: number; failures: number; throttles: number; total_ms: number; max_ms: number }>();
export function recordStorageOperation(operation: string, milliseconds: number, error?: unknown) {
  const value = counters.get(operation) ?? { count: 0, failures: 0, throttles: 0, total_ms: 0, max_ms: 0 };
  value.count++; value.total_ms += milliseconds; value.max_ms = Math.max(value.max_ms, milliseconds);
  if (error) value.failures++;
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  if (e?.name === 'SlowDown' || e?.Code === 'SlowDown' || e?.$metadata?.httpStatusCode === 429) value.throttles++;
  counters.set(operation, value);
}
export function takeStorageMetrics() {
  const result = Object.fromEntries(counters); counters.clear(); return result;
}
// Numeric aggregates only: never URLs, keys, customer payloads or credentials.
setInterval(() => {
  if (!counters.size) return;
  console.info(JSON.stringify({ event: 'firstmeasure_storage_operations', window_seconds: 60, pid: process.pid, operations: takeStorageMetrics() }));
}, 60_000).unref();
