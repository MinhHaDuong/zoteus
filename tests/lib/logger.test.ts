// tests/lib/logger.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../../src/lib/logger.js';

function capture(): { lines: string[]; outSpy: ReturnType<typeof vi.spyOn>; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    lines.push(String(c));
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return { lines, outSpy, restore: () => { spy.mockRestore(); outSpy.mockRestore(); } };
}
afterEach(() => vi.restoreAllMocks());

describe('logger', () => {
  it('text format redacts object args', () => {
    const { lines, outSpy, restore } = capture();
    createLogger('info', 'text').info('issued', { token: 'abc', clientId: 'c1' });
    restore();
    expect(lines.join('')).toContain('[zoteus] INFO');
    expect(lines.join('')).toContain('"token":"[REDACTED]"');
    expect(lines.join('')).toContain('"clientId":"c1"');
    expect(lines.join('')).not.toContain('abc');
    expect(outSpy).not.toHaveBeenCalled();
  });
  it('json format emits one parseable object per line with level/msg', () => {
    const { lines, outSpy, restore } = capture();
    createLogger('info', 'json').warn('careful', { apiKey: 'zzz' });
    restore();
    const obj = JSON.parse(lines.join('').trim());
    expect(obj.level).toBe('warn');
    expect(obj.msg).toContain('careful');
    expect(obj.msg).toContain('[REDACTED]');
    expect(obj.msg).not.toContain('zzz');
    expect(typeof obj.time).toBe('string');
    expect(outSpy).not.toHaveBeenCalled();
  });
  it('respects the level threshold', () => {
    const { lines, restore } = capture();
    createLogger('warn', 'text').info('hidden');
    restore();
    expect(lines.join('')).toBe('');
  });
});
