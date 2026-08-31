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

  it('setMax lowers the ceiling for work that has not started yet', async () => {
    // The #39 case: a crawl already under way discovers that what it is reading from cannot
    // take the load, and has to slow down without being restarted.
    const sem = new Semaphore(4);
    let active = 0;
    const seen: number[] = [];
    const task = async () =>
      sem.run(async () => {
        active++;
        seen.push(active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    const all = Array.from({ length: 12 }, task);
    // The first four are already out; everything queued behind them obeys the new ceiling.
    sem.setMax(1);
    await Promise.all(all);
    expect(Math.max(...seen.slice(4))).toBe(1);
    expect(seen).toHaveLength(12);
  });

  it('setMax raises the ceiling and releases what is waiting for it', async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let peak = 0;
    const task = async () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    const all = Array.from({ length: 6 }, task);
    sem.setMax(3);
    await Promise.all(all);
    expect(peak).toBe(3);
  });

  it('refuses a ceiling below one, which would deadlock every waiter', () => {
    expect(() => new Semaphore(0)).toThrow(/>= 1/);
    expect(() => new Semaphore(2).setMax(0)).toThrow(/>= 1/);
  });
});
