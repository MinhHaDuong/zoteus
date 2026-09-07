import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_ENV_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;

export default function setup() {
  const root = mkdtempSync(join(tmpdir(), 'zoteus-test-run-'));
  const previous = TEMP_ENV_VARS.map((name) => [name, process.env[name]] as const);
  for (const [name] of previous) process.env[name] = root;

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
  };
}
