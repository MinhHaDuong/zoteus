import { join } from 'node:path';
import { generateCodex } from '../src/codex/generate.js';
import { tools } from '../src/tools/index.js';

await generateCodex(tools, join(process.cwd(), 'codex'));
process.stderr.write(`Generated codex/ wrappers for ${tools.length} tools.\n`);
