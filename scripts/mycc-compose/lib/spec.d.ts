/**
 * Type declarations for scripts/mycc-compose/lib/spec.js.
 *
 * The implementation is plain ESM JavaScript (so a plain `node` process can
 * load it — see the .js header). TypeScript resolves the `./spec.js` import
 * specifier against this file, so the vitest spec-validation test at
 * src/tests/mycc-compose-spec.test.ts is fully type-checked even though
 * `allowJs` stays false.
 */

/** A peer record after validation (defaults resolved, args parsed). */
export interface NormalizedPeer {
  name: string;
  workdir: string;
  args: string;
  sessionId: string | null;
  renew: 'always' | 'onMismatch';
  parsedArgs: Record<string, unknown>;
}

/** A channel record after validation. */
export interface NormalizedChannel {
  from: string;
  to: string;
  label: string;
  prompt: string;
}

/** A validated topology spec. */
export interface NormalizedSpec {
  group: string;
  peers: NormalizedPeer[];
  channels: NormalizedChannel[];
}

/** UUID regex used to validate a peer's sessionId. */
export declare const UUID_RE: RegExp;

/**
 * Load and parse the spec file. Throws a descriptive Error on any I/O or JSON
 * error (missing file, unreadable, invalid JSON, non-object top level).
 */
export declare function loadSpec(file: string): Record<string, unknown>;

/**
 * Validate the whole spec. Returns a normalized spec or throws an Error.
 * NEVER mutates the input.
 */
export declare function validateSpec(spec: unknown): NormalizedSpec;

/**
 * Re-read the raw spec file, apply `mutate(raw)` to it, and write it back with
 * a stable 2-space indent. Used to persist minted session ids.
 */
export declare function updateSpecFile(
  file: string,
  mutate: (raw: Record<string, unknown>) => void,
): void;
