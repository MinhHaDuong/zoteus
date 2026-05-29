import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SearchIndex } from './index-manager.js';

export async function saveIndex(index: SearchIndex, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index.toJSON()));
}

export async function loadIndex(index: SearchIndex, path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf8');
    index.loadFromJSON(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}
