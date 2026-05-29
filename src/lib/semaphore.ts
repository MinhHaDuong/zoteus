export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
    this.available = max;
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
          const next = this.queue.shift();
          if (next) next();
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
