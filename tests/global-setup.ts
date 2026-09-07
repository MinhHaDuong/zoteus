import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup() {
  const root = mkdtempSync(join(tmpdir(), 'zoteus-test-run-'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;

  return () => {
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    rmSync(root, { recursive: true, force: true });
  };
}
