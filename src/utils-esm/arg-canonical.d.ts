/**
 * Type declarations for arg-canonical.js.
 *
 * The implementation is plain ESM JavaScript (see the .js header for why: it
 * must be loadable by BOTH tsx/TypeScript and the zero-dependency
 * `mycc-compose` bin). TypeScript resolves the `./arg-canonical.js` import
 * specifier against this file, so the import is fully type-checked even though
 * `allowJs` stays false.
 */

/** Flags that are booleans (never consume the following token as a value). */
export declare const BOOLEAN_FLAGS: string[];

/** Flags that always take a value. */
export declare const STRING_FLAGS: string[];

/** Default values passed to minimist so unset flags normalize deterministically. */
export declare const DEFAULTS: Record<string, boolean | null>;

/** Flags whose VALUE must never be published; rendered as `--<flag> ***`. */
export declare const SECRET_FLAGS: string[];

/**
 * Launcher-managed flags ignored during argsMatch() (e.g. `session-id`): they
 * are injected at spawn time and never authored in a spec.
 */
export declare const LAUNCHER_FLAGS: string[];

/** The redaction placeholder. Also treated as a wildcard by argsMatch(). */
export declare const REDACTED: '***';

/**
 * Short-flag aliases (`v` → `verbose`). Folding normalizes a published minimist
 * alias pair (`--v --verbose`) to the same key a spec renders (`--verbose`).
 */
export declare const ALIASES: Record<string, string>;

/** Resolve a flag name to its canonical (long) form. */
export declare function canonicalFlagName(name: string): string;

/**
 * Map of CLI-arg names to the MYCC_/provider env vars they mirror. Consumed by
 * buildCmdArgsEnv() so the whole cmd-arg vocabulary lives in one place.
 */
export declare const ARG_ENV_MAP: Record<string, string>;

/**
 * Turn a parsed args object into a `{ ENV_KEY: value }` map for the keys in
 * ARG_ENV_MAP. Unset flags (`undefined`/`null`/`false`) are omitted; values
 * are coerced to strings.
 */
export declare function buildCmdArgsEnv(parsed: Record<string, unknown>): Record<string, string>;

/** A parsed args object, shaped like minimist's output. */
export interface ParsedArgs {
  _: string[];
  [key: string]: unknown;
}

/**
 * Parse a whitespace-separated CLI-args string into an args object.
 * Returns `{ _: [] }` for an empty / `(none)` input.
 */
export declare function parseArgString(raw: string | null | undefined): ParsedArgs;

/**
 * Render a parsed args object as a display string (ORDER-PRESERVING):
 * `--flag` for booleans, `--flag value` otherwise, secrets redacted to
 * `--flag ***`, unset flags and positionals skipped. '(none)' when empty.
 */
export declare function formatLaunchArgs(parsed: Record<string, unknown>): string;

/**
 * Render a parsed args object for the SPAWN argv: identical to
 * formatLaunchArgs() but WITHOUT secret redaction. Redaction is a display
 * concern; the child process must receive the real secret value.
 */
export declare function formatLaunchArgsForSpawn(parsed: Record<string, unknown>): string;

/**
 * Render a KEY-SORTED canonical form for equality comparison (same rendering
 * rules as formatLaunchArgs, but flag order does not affect the result).
 */
export declare function canonicalArgs(parsed: Record<string, unknown>): string;

/**
 * True when a live instance's published args match a spec's args, comparing
 * key-sorted canonical forms with `***` as a value wildcard on either side.
 */
export declare function argsMatch(
  publishedArgs: string | null | undefined,
  specArgs: string | null | undefined,
): boolean;
