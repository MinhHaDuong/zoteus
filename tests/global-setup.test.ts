import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('test temporary directory', () => {
  it('confines worker temporary files to the run directory', () => {
    const root = tmpdir();
    expect(basename(root)).toMatch(/^zoteus-test-run-/);
    expect(process.env.TMPDIR).toBe(root);
    expect(process.env.TMP).toBe(root);
    expect(process.env.TEMP).toBe(root);
  });
});
