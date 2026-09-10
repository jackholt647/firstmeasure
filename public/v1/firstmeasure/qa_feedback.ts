type Thread = Record<string, any>;
/** Feedback is append-only by thread/event ID; stale views must not erase it. */
export function mergeQaFeedbackThreads(...sources: unknown[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const [index, value] of source.entries()) {
      if (!value || typeof value !== 'object') continue;
      const incoming = value as Thread;
      // Historical feedback without IDs used positional response matching.
      const key = incoming.id ? `id:${incoming.id}` : `legacy-index:${index}`;
      const previous = threads.get(key);
      if (!previous) { threads.set(key, structuredClone(incoming)); continue; }
      const history = [...new Map([...(Array.isArray(previous.history) ? previous.history : []), ...(Array.isArray(incoming.history) ? incoming.history : [])].map(event => [JSON.stringify(event), event])).values()];
      const latest = (thread: Thread) => Math.max(0, ...(Array.isArray(thread.history) ? thread.history : []).map(event => Date.parse(event.ts || '') || 0));
      const newer = latest(incoming) >= latest(previous) ? incoming : previous;
      threads.set(key, { ...previous, ...newer, history });
    }
  }
  return [...threads.values()];
}
