import { describe, it, expect, vi } from 'vitest';
import { StyleResolver } from '../../src/features/citation/styles.js';

describe('StyleResolver', () => {
  it('resolves common aliases and passes through ids', () => {
    const r = new StyleResolver();
    expect(r.resolveId('APA 7th')).toBe('apa');
    expect(r.resolveId('IEEE')).toBe('ieee');
    expect(r.resolveId('Chicago')).toBe('chicago-note-bibliography');
    expect(r.resolveId('some-custom-style')).toBe('some-custom-style');
  });

  it('fetches and caches a style', async () => {
    const fetchImpl = vi.fn(async () => new Response('<style>real</style>', { status: 200 }));
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    const a = await r.fetchStyle('apa');
    const b = await r.fetchStyle('apa');
    expect(a).toContain('real');
    expect(b).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a dependent style to its independent parent', async () => {
    const dependent =
      '<style><info><link href="http://www.zotero.org/styles/nature" rel="independent-parent"/></info></style>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/nature-biotechnology.csl')) return new Response(dependent, { status: 200 });
      if (url.endsWith('/nature.csl')) return new Response('<style>PARENT</style>', { status: 200 });
      return new Response('nope', { status: 404 });
    });
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    const xml = await r.fetchStyle('nature-biotechnology');
    expect(xml).toContain('PARENT');
  });

  it('falls back to en-US when a locale is missing', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('en-US') ? new Response('<locale>en</locale>', { status: 200 }) : new Response('x', { status: 404 }),
    );
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    const xml = await r.fetchLocale('zz-ZZ');
    expect(xml).toContain('en');
  });
});
