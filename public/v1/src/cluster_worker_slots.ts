export function takeClusterWorkerSlot(
  workerSlots: Map<number, number>,
  workerId: number,
  fallbackSlot = 1
) {
  const slot = workerSlots.get(workerId) ?? fallbackSlot;
  workerSlots.delete(workerId);
  return slot;
}
