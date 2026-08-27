/**
 * Values that mean "there is no value here", rather than a setting.
 *
 * A desktop-extension (`.mcpb`) client substitutes every env entry its manifest declares,
 * including the ones whose `user_config` field the user left empty. Where that field also
 * has no `default` in the manifest, Claude Desktop 1.37937 substitutes nothing at all: it
 * passes the reference through verbatim, so the server is handed the literal text
 * `${user_config.embed_batch_size}`. That is #18, read out of `/proc/<pid>/environ` of the
 * running extension rather than inferred. A blank string is the other form, which is what
 * a bare `KEY=` line in a .env file produces and what earlier hosts sent for an empty
 * field; `undefined`, `null` and `NaN` are what a host that stringifies an absent value
 * would send, and are covered because this has already been guessed wrong once.
 *
 * This lives apart from the config schema because `defaultDataDir` has to agree with it.
 * When the two disagreed, a marker rejected by the schema was handed straight back by the
 * fallback that reads the raw environment, and the server made a directory named
 * `${user_config.data_dir}` in whatever the working directory happened to be.
 */
const UNSET_MARKER = /^(?:undefined|null|nan|\$\{.*\})$/i;

export const isUnset = (v: unknown): boolean =>
  typeof v === 'string' && (v.trim() === '' || UNSET_MARKER.test(v.trim()));

/**
 * A value that is unmistakably an interpolation that never happened, as opposed to one a
 * person could have meant. `docker run --env-file` does no interpolation at all, so a
 * `KEY=${SOMETHING}` line in an env file arrives exactly like this. Where a blank means
 * "no restriction", that difference decides between failing open and refusing to start.
 */
export const looksUnexpanded = (v: unknown): boolean =>
  typeof v === 'string' && /^\$\{.*\}$/.test(v.trim());
