/**
 * The third-party attribution the running server has to display, and why it is here (#70).
 *
 * citeproc-js, which formats every bibliography Zoteus renders, is dual licensed
 * "CPAL-1.0 OR AGPL-1.0". Zoteus is MIT, so it takes the CPAL option, and Section 14 of the
 * CPAL asks that the Attribution Information named in its Exhibit B be displayed each time a
 * session begins, on the graphic user interface used to reach the covered code. An MCP
 * server has no window, so its two text surfaces stand in for the splash screen: the log
 * stream an operator watches, written once per process from src/index.ts, and the result of
 * `zotero_whoami`, the tool the server tells every client to call first, which is the one
 * place in the protocol where the phrase reliably reaches a person once per session.
 *
 * The strings below are Exhibit B verbatim; do not reword them. THIRD_PARTY_NOTICES.md
 * carries the same three lines plus the licence choice, and tests/lib/notices.test.ts pins
 * the two to each other so neither can drift.
 */
export const CITEPROC_ATTRIBUTION = {
  /** Exhibit B, "Attribution Copyright Notice". */
  copyright: '(c) Frank Bennett',
  /** Exhibit B, "Attribution Phrase (not exceeding 10 words)". */
  phrase: 'citeproc-js implements the Citation Style Language',
  /** Exhibit B, "Attribution URL". */
  url: 'https://citationstyles.org/',
  /** Which of the two options in citeproc's own LICENSE Zoteus redistributes it under. */
  license: 'Common Public Attribution License 1.0',
} as const;

/** The one line the log carries at startup and `zotero_whoami` appends to its summary. */
export const ATTRIBUTION_LINE =
  `${CITEPROC_ATTRIBUTION.phrase} (${CITEPROC_ATTRIBUTION.copyright}), ` +
  `used under the ${CITEPROC_ATTRIBUTION.license}: ${CITEPROC_ATTRIBUTION.url}`;
