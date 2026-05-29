import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/lib/semaphore.js';

describe('Semaphore', () => {
  it('limits concurrency to the configured max', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 6 }, task));
    expect(maxActive).toBe(2);
  });

  it('run() acquires and releases around a function, even on throw', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });
});
