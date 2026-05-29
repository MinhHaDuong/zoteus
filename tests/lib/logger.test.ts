import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../../src/lib/logger.js';

describe('createLogger', () => {
  it('writes to stderr, never stdout', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = createLogger('info');
    log.info('hello');
    expect(errSpy).toHaveBeenCalled();
    expect(outSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    outSpy.mockRestore();
  });

  it('suppresses debug when level is info', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const log = createLogger('info');
    log.debug('quiet');
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
