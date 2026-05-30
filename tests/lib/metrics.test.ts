// tests/lib/metrics.test.ts
import { describe, it, expect } from 'vitest';
import { createMetrics } from '../../src/lib/metrics.js';

describe('metrics', () => {
  it('counts and renders Prometheus text', () => {
    const m = createMetrics();
    m.inc('http_requests_total', 1, { status_class: '2xx' });
    m.inc('http_requests_total', 1, { status_class: '2xx' });
    m.inc('http_requests_total', 1, { status_class: '5xx' });
    m.inc('tokens_issued_total');
    const text = m.render();
    expect(text).toContain('zoteus_http_requests_total{status_class="2xx"} 2');
    expect(text).toContain('zoteus_http_requests_total{status_class="5xx"} 1');
    expect(text).toContain('zoteus_tokens_issued_total 1');
    expect(m.snapshot()['tokens_issued_total']).toBe(1);
  });
});
