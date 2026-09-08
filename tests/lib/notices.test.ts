/**
 * The citeproc-js attribution (#70).
 *
 * citeproc is dual licensed "CPAL-1.0 OR AGPL-1.0" and is the only production dependency
 * that is not permissive. Zoteus takes the CPAL option, and the CPAL's Exhibit B names three
 * strings that must be displayed when a session begins. These tests hold three things
 * together that would otherwise drift apart: the constants the server displays, the words
 * Exhibit B actually uses, and THIRD_PARTY_NOTICES.md. They also check that the notices file
 * reaches every artefact that redistributes citeproc, since a notice only in the git tree is
 * exactly the gap the issue reported.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_LINE, CITEPROC_ATTRIBUTION } from '../../src/lib/notices.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string): string => readFileSync(join(repo, file), 'utf8');
const notices = read('THIRD_PARTY_NOTICES.md');

/** Exhibit B of the CPAL as published in the citeproc-js repository, copied verbatim. */
const EXHIBIT_B = {
  copyright: '(c) Frank Bennett',
  phrase: 'citeproc-js implements the Citation Style Language',
  url: 'https://citationstyles.org/',
};

describe('the attribution the server displays', () => {
  it('is Exhibit B word for word', () => {
    expect(CITEPROC_ATTRIBUTION.copyright).toBe(EXHIBIT_B.copyright);
    expect(CITEPROC_ATTRIBUTION.phrase).toBe(EXHIBIT_B.phrase);
    expect(CITEPROC_ATTRIBUTION.url).toBe(EXHIBIT_B.url);
  });

  it('names the CPAL, which is the option Zoteus takes, and never the AGPL', () => {
    expect(CITEPROC_ATTRIBUTION.license).toBe('Common Public Attribution License 1.0');
    expect(ATTRIBUTION_LINE).not.toMatch(/AGPL|Affero/i);
  });

  it('carries all three Exhibit B items in one line', () => {
    for (const value of Object.values(EXHIBIT_B)) expect(ATTRIBUTION_LINE).toContain(value);
  });

  it('stays within the ten words Exhibit B allows the phrase', () => {
    expect(CITEPROC_ATTRIBUTION.phrase.split(/\s+/).length).toBeLessThanOrEqual(10);
  });
});

describe('THIRD_PARTY_NOTICES.md', () => {
  it('reproduces the copyright notice, the phrase and the URL', () => {
    for (const value of Object.values(EXHIBIT_B)) expect(notices).toContain(value);
  });

  it('says in writing which of the two licence options Zoteus takes', () => {
    expect(notices).toContain('Zoteus takes the CPAL option');
    expect(notices).toContain('Common Public Attribution License 1.0');
    expect(notices).toMatch(/not under the AGPL/);
  });

  it('names citeproc as the dependency the notice is for', () => {
    expect(notices).toContain('citeproc');
  });
});

describe('the notices file reaches the artefacts that redistribute citeproc', () => {
  it('is published with the npm package', () => {
    const pkg = JSON.parse(read('package.json')) as { files: string[] };
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES.md');
  });

  it('is copied into the container image alongside package.json', () => {
    expect(read('Dockerfile')).toMatch(/^COPY .*THIRD_PARTY_NOTICES\.md .*\.\/$/m);
  });

  it('is not excluded from the Docker build context', () => {
    for (const line of read('.dockerignore').split('\n')) {
      expect('THIRD_PARTY_NOTICES.md').not.toBe(line.trim());
    }
  });

  // The .mcpb side is pinned in tests/scripts/mcpb-bundle.test.ts: staging copies it, and
  // auditBundle refuses an archive without it.
});
