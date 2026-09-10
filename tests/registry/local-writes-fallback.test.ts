import { describe, it, expect } from 'vitest';
import { isLocalWritesUnavailable } from '../../src/registry/registry.js';

/**
 * The predicate decides whether a failed desktop write may be retried against the cloud.
 * Getting it wrong in either direction is bad: too narrow and a working cloud key goes
 * unused, too wide and a refusal or a validation error is quietly routed around.
 */
describe('isLocalWritesUnavailable', () => {
  it('accepts a Zotero 9 style GET-only local API', () => {
    expect(isLocalWritesUnavailable(new Error('Local API 404 for /users/0/items'))).toBe(true);
    expect(isLocalWritesUnavailable(new Error('Local API: Endpoint does not support method'))).toBe(true);
    expect(isLocalWritesUnavailable(new Error('Local API unreachable'))).toBe(true);
  });

  // A 401 only reaches a caller after LocalWriteClient has already dropped its key,
  // re-authorized and retried once, so it means the grant is gone rather than momentarily
  // stale. An unattended run whose re-authorization dialog nobody answered used to stop
  // here with a perfectly good cloud key it never tried.
  it('accepts a grant that is gone, so the cloud can serve the write instead', () => {
    expect(
      isLocalWritesUnavailable(new Error('Local API local write failed (401): Invalid or expired API key')),
    ).toBe(true);
  });

  // Someone who just pressed "Deny" is not asking for the write to happen elsewhere.
  it('refuses to route around an explicit denial', () => {
    expect(
      isLocalWritesUnavailable(
        new Error('Zotero local write access was denied. Re-run when you can accept the dialog in Zotero.'),
      ),
    ).toBe(false);
  });

  it('leaves real write failures alone', () => {
    expect(isLocalWritesUnavailable(new Error('Local API 400: itemType property not provided'))).toBe(false);
    expect(isLocalWritesUnavailable(new Error('Local API 412: precondition failed'))).toBe(false);
    expect(isLocalWritesUnavailable(new Error('some unrelated failure'))).toBe(false);
  });
});
