import { describe, it, expect } from 'vitest';
import { renderLicensePage } from '../../src/auth/license-page.js';

describe('renderLicensePage', () => {
  it('renders the key field carrying auth_id and posts to ./license', () => {
    const html = renderLicensePage({ authId: 'A-1', clientName: 'Claude', redirectHost: 'claude.ai' });
    expect(html).toContain('name="auth_id" value="A-1"');
    expect(html).toContain('name="license_key"');
    expect(html).toContain('action="license"');
    expect(html).toContain('claude.ai');
  });
  it('shows an error + a Subscribe link when provided', () => {
    const html = renderLicensePage({
      authId: 'A-1', clientName: 'Claude', redirectHost: 'claude.ai',
      error: 'Subscription not active.', checkoutUrl: 'https://buy.polar.sh/x',
    });
    expect(html).toContain('Subscription not active.');
    expect(html).toContain('https://buy.polar.sh/x');
  });
  it('escapes interpolated values + omits the link when no checkout URL', () => {
    const html = renderLicensePage({ authId: '"><x', clientName: '<b>', redirectHost: 'h' });
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('"><x');
    expect(html).not.toContain('Subscribe');
  });
});
