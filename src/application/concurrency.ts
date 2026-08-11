/** Maps items with bounded async concurrency while preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.min(Math.max(normalizedConcurrency, 1), items.length);
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
