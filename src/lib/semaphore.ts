export class Semaphore {
  private max: number;
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
    this.max = max;
    this.available = max;
  }

  /**
   * Change the ceiling on a semaphore that is already in use.
   *
   * Lowering it never interrupts work that is already out: the permits in hand are honoured
   * and `available` simply goes negative, so the queue stays parked until enough releases
   * have brought it back above zero. That is what lets a crawl already under way back off
   * from a server it has overwhelmed instead of having to be restarted (#39).
   */
  setMax(max: number): void {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
    this.available += max - this.max;
    this.max = max;
    // Raising the ceiling has to hand out the permits it just created; nothing else is
    // going to come along and release one on their behalf.
    while (this.available > 0 && this.queue.length) this.queue.shift()!();
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.available--;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.available++;
          // Guarded rather than unconditional, because `available` can be negative after a
          // setMax that lowered the ceiling: releasing then means one fewer holder, not a
          // free permit to pass on. Without the test the queue would drain at the OLD
          // ceiling and the new one would never take effect.
          if (this.available > 0) {
            const next = this.queue.shift();
            if (next) next();
          }
        });
      };
      if (this.available > 0) grant();
      else this.queue.push(grant);
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
