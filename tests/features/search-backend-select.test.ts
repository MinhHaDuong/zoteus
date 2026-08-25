import { describe, it, expect, vi } from 'vitest';

/**
 * This runtime HAS node:sqlite, so a runtime without it is simulated by making the very
 * require the factory probes with fail, exactly as Node 22.12 and earlier do. Kept in its
 * own file because the mock is module-wide.
 */
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const real = actual.createRequire(url);
      const guarded = (id: string) => {
        if (id === 'node:sqlite') throw new Error("Cannot find module 'node:sqlite'");
        return real(id);
      };
      return Object.assign(guarded, real);
    },
  };
});

const { createSearchIndex, nodeSqliteAvailable } = await import('../../src/features/search/factory.js');

function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      debug: () => {},
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
    },
  };
}

describe('ZOTEUS_INDEX_BACKEND on a runtime without node:sqlite', () => {
  it('detects the absence rather than throwing on import', () => {
    expect(nodeSqliteAvailable()).toBe(false);
  });

  it('refuses to start when sqlite was asked for explicitly', async () => {
    // Silently downgrading an operator who chose the durable backend is how a large
    // library would go on hitting the JSON ceiling with nothing to show for it.
    await expect(
      createSearchIndex({ embedder: null, backend: 'sqlite', jsonPath: '' }),
    ).rejects.toThrow(/ZOTEUS_INDEX_BACKEND=sqlite/);
    await expect(
      createSearchIndex({ embedder: null, backend: 'sqlite', jsonPath: '' }),
    ).rejects.toThrow(/22\.13/);
  });

  it('falls back to the JSON backend under auto, and says what that costs', async () => {
    const { lines, logger } = recordingLogger();
    const index = await createSearchIndex({ embedder: null, logger, backend: 'auto', jsonPath: '' });

    expect(index.storage).toBe('memory');
    expect(lines.join(' ')).toMatch(/node:sqlite is unavailable/);
    expect(lines.join(' ')).toMatch(/Node 22\.13\+/);
    await index.close();
  });

  it('says nothing about SQLite when the JSON backend was the choice', async () => {
    const { lines, logger } = recordingLogger();
    const index = await createSearchIndex({ embedder: null, logger, backend: 'memory', jsonPath: '' });

    expect(index.storage).toBe('memory');
    expect(lines).toEqual([]);
    await index.close();
  });
});
