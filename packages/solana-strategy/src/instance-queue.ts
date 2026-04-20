/**
 * Per-instance dispatch queue.
 *
 * Guarantees strict FIFO serialization for all tasks submitted to a single
 * instance: each task runs to completion before the next begins, regardless
 * of how many callers enqueue concurrently.
 *
 * The signature accepts `() => Promise<T> | T` (sync tasks are valid because
 * `await` on a non-thenable returns the value directly — zero overhead, and
 * callers need not wrap synchronous work in a Promise).
 *
 * Error isolation: a rejected task rejects only the promise returned to its
 * caller; the internal chain stays alive so subsequent tasks are unaffected.
 */
export class InstanceQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    let resolveTask!: (v: T) => void;
    let rejectTask!: (e: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolveTask = res;
      rejectTask = rej;
    });
    this.chain = this.chain.then(async () => {
      try {
        resolveTask(await task());
      } catch (err) {
        rejectTask(err);
      }
    });
    return result;
  }
}
