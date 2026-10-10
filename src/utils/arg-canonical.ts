/**
 * arg-canonical.ts - THE canonical CLI-argument table, parser and formatters.
 *
 * This module is the single source of truth for the CLI-arg vocabulary shared
 * by BOTH sides of the compose feature:
 *
 *   1. `src/config.ts`  - spreads the flag tables into its minimist() call and
 *                         delegates getLaunchArgs() here.
 *   2. `scripts/mycc-compose/mycc-compose.js` - the `bin` CLI (a thin .js shim
 *                         that registers the tsx loader, then imports the .ts
 *                         lib modules). It parses the spec's `args` string with
 *                         the SAME table and compares the result with the args
 *                         a live instance published in identity.json.
 *
 * Because both sides are table-driven, the classic "Number vs String" trap
 * (`--token-threshold 80000` parsing to a number on one side and staying a
 * string on the other) cannot occur: both sides go through
 * `parseArgString()` below.
 *
 * Two distinct canonical forms, deliberately:
 *
 *   - `formatLaunchArgs(parsed)` is ORDER-PRESERVING. Used to publish/display
 *     how an instance was launched (system-prompt self-identity, identity.json
 *     `args`), so the string stays faithful to the invocation.
 *   - `canonicalArgs(parsed)` is KEY-SORTED. Used for EQUALITY only, so
 *     `--auto --skip-healthcheck` and `--skip-healthcheck --auto` compare
 *     equal instead of false-mismatching and restarting a healthy peer.
 */

// ---------------------------------------------------------------------------
// The canonical flag table - the single source of truth
// ---------------------------------------------------------------------------

/**
 * Flags that are booleans (never consume the following token as a value).
 *
 * NOTE: 'serve' is intentionally absent — it is auto-detected (bare `--serve`
 * → true, `--serve 9000` → the port). See src/config.ts for the full rationale.
 */
export const BOOLEAN_FLAGS: string[] = [
  'v', 'verbose', 'skip-healthcheck', 'setup',
  'debug-eval', 'debug-tp', 'disable-crossroad', 'auto',
  'debug-autofly', 'allow-plan-off', 'debug-wire', 'debug-ansi',
];

/** Flags that always take a value. */
export const STRING_FLAGS: string[] = [
  'from', 'port', 'host', 'max-upload-mb', 'autofly', 'daemon',
  'ollama-host', 'ollama-api-key', 'ollama-model', 'ollama-vision-model', 'ollama-embedding-model',
  'deepseek-host', 'deepseek-api-key', 'deepseek-model', 'deepseek-vision-model',
  'api-provider', 'token-threshold', 'editor', 'skill-match-threshold',
  'wire-token',
  // Session pinning (compose): lets mycc-topology re-pin a peer's session id.
  'session-id',
  // Auto-mode commit pre-authorization: a comma-separated allow-list of branch
  // names. STRING (carries a value), not boolean. Absent from DEFAULTS like
  // 'allow-plan-off' — absence means "off", and the parser/argsMatch treat
  // unset uniformly. See config.ts's getAllowAutoCommitBranches().
  'allow-auto-commit',
];

/** Default values passed to minimist so unset flags normalize deterministically. */
export const DEFAULTS: Record<string, boolean | null> = {
  v: false,
  from: null,
  port: null,
  'skip-healthcheck': false,
  setup: false,
  'debug-eval': false,
  'debug-tp': false,
  'disable-crossroad': false,
  'debug-autofly': false,
  'allow-plan-off': false,
};

/**
 * Flags whose VALUE must never be published (prompt, logs, identity.json).
 * They are rendered as `--<flag> ***` by formatLaunchArgs().
 */
export const SECRET_FLAGS: string[] = ['ollama-api-key', 'deepseek-api-key', 'wire-token'];

/**
 * Flags that are launcher-managed and MUST be ignored when comparing a spec's
 * args against a live instance's published args. `--session-id` is supplied by
 * the launcher (`mycc-compose`) at spawn time, never authored in the spec, so a
 * peer launched under a pinned sid would otherwise always look like a mismatch
 * (`{--session-id, --auto}` vs `{--auto}`) and be needlessly restarted.
 */
export const LAUNCHER_FLAGS: string[] = ['session-id'];

/** The redaction placeholder. Also a wildcard in argsMatch(). */
export const REDACTED = '***' as const;

/**
 * Short-flag aliases: `<short>` is an alias of `<long>`.
 *
 * Why this table exists: `src/config.ts` hands minimist `alias: { v: ['verbose'] }`,
 * so minimist EXPANDS `-v` into BOTH keys — `{ v: true, verbose: true }` — and
 * getLaunchArgs() (which delegates to formatLaunchArgs) then publishes
 * `--v --verbose`. The compose spec side renders only `--verbose`, so before
 * alias folding, argsMatch() returned FALSE for every `-v` peer: `up` renewed a
 * healthy peer on every run and `sync` reported a permanent mismatch.
 *
 * Folding normalizes BOTH forms to the long name, so a published
 * `--v --verbose` and a spec `--verbose` compare equal.
 */
export const ALIASES: Record<string, string> = { v: 'verbose' };

/** Resolve a flag name to its canonical (long) form. */
export function canonicalFlagName(name: string): string {
  return Object.prototype.hasOwnProperty.call(ALIASES, name) ? ALIASES[name] : name;
}

/**
 * Map of CLI-arg names to the MYCC_/provider env vars they mirror.
 *
 * `config.ts` builds these into process.env at startup so downstream modules
 * can read `process.env.MYCC_*` without knowing about minimist. It is the
 * SAME key vocabulary as {@link BOOLEAN_FLAGS}/{@link STRING_FLAGS} — it lives
 * here so the whole cmd-arg vocabulary is defined in ONE place instead of
 * being split between the flag table and a second map in config.ts.
 */
export const ARG_ENV_MAP: Record<string, string> = {
  'verbose': 'MYCC_VERBOSE',
  'from': 'MYCC_FROM_SESSION',
  // --session-id pins a fresh session's identity (see getPinnedSessionId);
  // mirrored so it survives a restart/reload spawn that drops argv.
  'session-id': 'MYCC_SESSION_ID',
  'skip-healthcheck': 'MYCC_SKIP_HEALTHCHECK',
  'setup': 'MYCC_SETUP',
  'debug-eval': 'MYCC_DEBUG_EVAL',
  'debug-tp': 'MYCC_DEBUG_TP',
  'disable-crossroad': 'MYCC_DISABLE_CROSSROAD',
  'debug-autofly': 'MYCC_DEBUG_AUTOfLY',
  'allow-plan-off': 'MYCC_ALLOW_PLAN_OFF',
  // --allow-auto-commit: auto-mode peers may commit WITHOUT the interactive
  // confirmation, but only on the branches listed here, only in NORMAL mode,
  // and only with an audit trailer. Pair with CI on protected branches (the
  // real authority). Immutable / operator-only: no slash toggle, the agent
  // cannot self-grant.
  'allow-auto-commit': 'MYCC_ALLOW_AUTO_COMMIT',
  // --debug-ansi: force the plain (no-TTY) output path while in a terminal,
  // so the piped-rendering path can be reproduced without a second shell.
  // Mirrored into env like the other debug flags so it survives the
  // restart/reload spawns, which do not carry the original argv.
  'debug-ansi': 'MYCC_DEBUG_ANSI',
  // Env-configurable vars (override .env files)
  'ollama-host': 'OLLAMA_HOST',
  'ollama-api-key': 'OLLAMA_API_KEY',
  'ollama-model': 'OLLAMA_MODEL',
  'ollama-vision-model': 'OLLAMA_VISION_MODEL',
  'ollama-embedding-model': 'OLLAMA_EMBEDDING_MODEL',
  'deepseek-host': 'DEEPSEEK_HOST',
  'deepseek-api-key': 'DEEPSEEK_API_KEY',
  'deepseek-model': 'DEEPSEEK_MODEL',
  // --deepseek-vision-model mirrors DEEPSEEK_VISION_MODEL (default deepseek-flash).
  // The DeepSeek counterpart of OLLAMA_VISION_MODEL; used by the vision path
  // (screen / read_picture → imgDescribe) when API_PROVIDER=deepseek.
  'deepseek-vision-model': 'DEEPSEEK_VISION_MODEL',
  'api-provider': 'API_PROVIDER',
  'token-threshold': 'TOKEN_THRESHOLD',
  'editor': 'EDITOR',
  'skill-match-threshold': 'SKILL_MATCH_THRESHOLD',
  // Remote peer wire: --wire-token mirrors the MYCC_WIRE_TOKEN env var
  // (OPTIONAL shared secret); --debug-wire mirrors the
  // MYCC_WIRE_ALLOW_LOCAL=1 escape hatch (test-only; allows same-store /
  // self wire connects). Neither is part of the --setup wizard.
  'wire-token': 'MYCC_WIRE_TOKEN',
  'debug-wire': 'MYCC_WIRE_ALLOW_LOCAL',
};

/**
 * Turn a parsed args object into a `{ ENV_KEY: value }` map for the keys in
 * {@link ARG_ENV_MAP}. A flag that is unset (`undefined`/`null`/`false`) is
 * omitted, so it never clobbers an env var set elsewhere. Values are coerced
 * to strings (env vars are strings).
 *
 * Consumed by config.ts's loadEnv() to merge cmd-args into process.env at the
 * highest priority.
 */
export function buildCmdArgsEnv(parsed: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  if (!parsed || typeof parsed !== 'object') return env;
  for (const [argKey, envKey] of Object.entries(ARG_ENV_MAP)) {
    const value = parsed[argKey];
    if (value !== undefined && value !== null && value !== false) {
      env[envKey] = String(value);
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** A parsed args object, shaped like minimist's output. */
export interface ParsedArgs {
  _: string[];
  [key: string]: unknown;
}

/** True when `value` was not set (mirrors config.ts's "flag not set" rule). */
function isUnset(value: unknown): boolean {
  return value === false || value === null || value === undefined || value === '';
}

/**
 * Parse a whitespace-separated CLI-args string into an args object shaped like
 * minimist's output.
 *
 * Supports: `--key value`, `--key=value`, bare boolean `--flag`, `-v`
 * (verbose alias), and (ignored) positional tokens collected into `_`.
 * Repeated flags collect into an array, matching minimist.
 *
 * Unknown `--flags` are collected as booleans (minimist auto-detects a bare
 * flag the same way) so the canonical form still contains them rather than
 * silently dropping a flag the user passed.
 *
 * Returns `{ _: [] }` for an empty / `(none)` input.
 */
export function parseArgString(raw: string | null | undefined): ParsedArgs {
  const out: ParsedArgs = { _: [] };
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim() === '(none)') return out;

  const tokens = raw.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // --key=value
    if (tok.startsWith('--') && tok.includes('=')) {
      const eq = tok.indexOf('=');
      setValue(out, tok.slice(2, eq), tok.slice(eq + 1));
      continue;
    }

    // --key  (value may follow)
    if (tok.startsWith('--')) {
      const name = tok.slice(2);
      if (name === '') continue;
      if (BOOLEAN_FLAGS.includes(name)) {
        setValue(out, name, true);
        continue;
      }
      if (STRING_FLAGS.includes(name)) {
        const next = tokens[i + 1];
        // Take the next token as the value unless it looks like another flag.
        // A trailing string-flag with no value (bare `--daemon`) is recorded as
        // `true`, NOT as '' — minimist's "" is dropped by isUnset() while the
        // spec side kept `true`, which false-mismatched every `--daemon` peer.
        // `--daemon` is one of the two flags the schema mandates, so this
        // divergence hit the advertised happy path.
        if (next !== undefined && !next.startsWith('-')) {
          setValue(out, name, next);
          i++;
        } else {
          setValue(out, name, true);
        }
        continue;
      }
      // Unknown long flag: minimist auto-detects — if the NEXT token is not a
      // flag, take it as the value; otherwise the flag is boolean. This is what
      // makes `--serve 9000` parse to 9000 (no table entry needed) and keeps a
      // repeated `--flag a --flag b` collecting values rather than booleans.
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        setValue(out, name, next);
        i++;
      } else {
        setValue(out, name, true);
      }
      continue;
    }

    // -v / -h style short flags: `-v` is an alias of `--verbose` (see ALIASES).
    // Unknown short flags are recorded verbatim as booleans so they survive the
    // round-trip.
    if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      const name = tok.slice(1);
      if (Object.prototype.hasOwnProperty.call(ALIASES, name)) {
        setValue(out, ALIASES[name], true);
      } else {
        setValue(out, name, true);
      }
      continue;
    }

    out._.push(tok);
  }
  return out;
}

/**
 * Record a value, collecting repeats into an array (minimist behaviour).
 * Alias names are folded to their canonical (long) form so `-v` and `--verbose`
 * land on the same key instead of diverging.
 */
function setValue(out: ParsedArgs, key: string, value: unknown): void {
  const k = canonicalFlagName(key);
  if (k in out) {
    const prev = out[k];
    if (Array.isArray(prev)) prev.push(value);
    else out[k] = [prev, value];
  } else {
    out[k] = value;
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Render a parsed args object as a display string: `--flag` for booleans,
 * `--flag value` otherwise, secrets redacted to `--flag ***`, unset flags and
 * positionals skipped. ORDER-PRESERVING. Returns '(none)' when nothing is set.
 *
 * This is the historical body of config.ts's getLaunchArgs(), moved here so
 * the compose script can produce/compare an identical string.
 */
export function formatLaunchArgs(parsed: Record<string, unknown>): string {
  return renderArgs(parsed, { redact: true });
}

/**
 * Render a parsed args object for the SPAWN argv: identical to
 * formatLaunchArgs() but WITHOUT secret redaction.
 *
 * Why both exist: formatLaunchArgs() redacts SECRET_FLAGS to `***` so the value
 * never lands in identity.json, the system prompt, or a log. The compose CLI
 * originally reused that same redacting formatter to build the child's argv —
 * so a peer launched from a spec containing `--wire-token REAL` was actually
 * spawned with the literal string `***`, i.e. unauthenticated. Redaction is a
 * DISPLAY concern; the spawn path must carry the real value.
 */
export function formatLaunchArgsForSpawn(parsed: Record<string, unknown>): string {
  return renderArgs(parsed, { redact: false });
}

/** Shared renderer behind the two public formatters. */
function renderArgs(parsed: Record<string, unknown>, opts: { redact: boolean }): string {
  if (!parsed || typeof parsed !== 'object') return '(none)';
  const parts: string[] = [];
  for (const [rawKey, value] of Object.entries(parsed)) {
    if (rawKey === '_') continue; // positional args
    if (value === undefined) continue;
    // Fold `v` onto `verbose` so an object carrying both alias forms (minimist
    // with alias:{v:['verbose']} produces exactly that) renders ONCE.
    const key = canonicalFlagName(rawKey);
    if (opts.redact && SECRET_FLAGS.includes(key)) {
      // Redact only if not already emitted (the folded key may repeat).
      if (!parts.some((p) => p === `--${key} ${REDACTED}`)) {
        parts.push(`--${key} ${REDACTED}`);
      }
      continue;
    }
    if (value === true) {
      // Bare flag: emit unless an EQUIVALENT group is already present. The
      // equivalence must be key-aware — `parts.includes('--v')` is FALSE for an
      // existing `--verbose`, which would re-emit the folded alias as `--v`.
      emitFlag(parts, key);
    } else if (isUnset(value)) {
      continue; // flag not set
    } else if (Array.isArray(value)) {
      // Repeated flag: `--f a --f b` (values already validated by the parser).
      for (const v of value) {
        if (v === true) {
          emitFlag(parts, key);
        } else if (!isUnset(v)) parts.push(`--${key} ${v}`);
      }
    } else {
      parts.push(`--${key} ${value}`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : '(none)';
}

/**
 * Emit a bare `--flag` group exactly once, using ALIAS-AWARE equivalence.
 *
 * A naive `parts.includes(`--${key}`)` compare compares the rendered STRING,
 * not the flag identity: an already-emitted `--verbose` does not equal the
 * string `--v`, so a parsed object carrying both alias forms (which minimist's
 * `alias:{v:['verbose']}` produces) rendered `--v --verbose`. Compare the flag
 * NAME via canonicalFlagName instead.
 */
function emitFlag(parts: string[], key: string): void {
  const exists = parts.some((p) => canonicalFlagName(p.startsWith('--') ? p.slice(2) : p) === key);
  if (!exists) parts.push(`--${key}`);
}

/**
 * Build the respawn argv for `/reload` by REPLAYING the old Lead's original
 * launch argv and merging the CURRENT serve state on top.
 *
 * Why replay rather than rebuild: `/reload` reuses the Coordinator but starts a
 * brand-new Lead process, which re-parses its argv from scratch. Rebuilding the
 * argv from serve state alone (the historical behaviour) silently dropped every
 * other launch flag — a reloaded `--auto` peer lost `--allow-auto-commit`, a
 * `--token-threshold` override reverted to the .env default, etc. Replaying the
 * original argv keeps the new Lead identically configured.
 *
 * Transformations, in order:
 *   1. Drop positionals and `--from <id> / --from=<id>` tokens: /reload must
 *      start a FRESH session (no context pre-population), so a stray --from in
 *      the replayed argv is filtered out. (The dispatch site already excludes
 *      positionals; this defends the invariant regardless.)
 *   2. Drop any pre-existing serve tokens (`--serve[=port]`, `--serve port`,
 *      `--port[=n]`, `--port n`, `--host[=h]`, `--host h`) so the stale
 *      original serve flag cannot fight the live state merged next.
 *   3. When serve is active, append `--serve <port>` (and `--host <host>`)
 *      from the CURRENT hub reading, which is authoritative over the original
 *      flag (the user may have re-/served on another port mid-session). When
 *      serve is off, nothing is appended — the new Lead starts in terminal mode.
 *      `--host''` (bind-all) is preserved as a bare `--host`.
 *
 * `--skip-healthcheck` is deliberately NOT handled here: startLead() re-appends
 * it from the Coordinator's own `skipHealthCheck` const.
 */
export function buildReloadArgs(
  originalArgv: string[],
  serveActive: boolean,
  servePort: number,
  serveHost: string | null,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < originalArgv.length; i++) {
    const tok = originalArgv[i];

    // A `--flag=value` token: keep the whole token unless it is a serve/from
    // flag. Value is attached, so nothing to consume.
    if (tok.startsWith('--') && tok.includes('=')) {
      const name = tok.slice(2, tok.indexOf('='));
      if (name === 'from') continue;              // fresh session — never replay
      if (name === 'serve' || name === 'port' || name === 'host') continue; // live state merged below
      out.push(tok);
      continue;
    }

    // A non-flag token is a positional or a flag VALUE. Flag values are
    // consumed by their flag's iteration below; a stray positional is dropped.
    if (!tok.startsWith('-')) continue;

    // Short flags: keep verbatim (no value is attached to `-v`).
    if (!tok.startsWith('--')) {
      out.push(tok);
      continue;
    }

    const name = tok.slice(2);

    // Does this flag consume the NEXT token as its value? Boolean flags never;
    // known string flags always (when the next token is not another flag,
    // mirroring the parser); unknown flags auto-detect like minimist.
    const consumesValue = !BOOLEAN_FLAGS.includes(name) && (
      STRING_FLAGS.includes(name) ||
      (i + 1 < originalArgv.length && !originalArgv[i + 1].startsWith('-'))
    );
    const hasValue = consumesValue && i + 1 < originalArgv.length && !originalArgv[i + 1].startsWith('-');

    if (name === 'from') {
      // /reload starts a fresh session — never carry --from (or its value).
      if (hasValue) i++;
      continue;
    }
    if (name === 'serve' || name === 'port' || name === 'host') {
      // Drop the original serve tokens (and their space value); the live
      // serve state is merged below.
      if (hasValue) i++;
      continue;
    }

    out.push(tok);
    if (hasValue) {
      out.push(originalArgv[i + 1]);
      i++;
    }
  }

  if (serveActive && servePort > 0) {
    out.push('--serve', String(servePort));
    if (serveHost) out.push('--host', serveHost);
  }

  return out;
}

/**
 * Render a KEY-SORTED canonical form for equality comparison. Same rendering
 * rules as formatLaunchArgs(), but the `--flag` groups are sorted, so flag
 * ORDER does not affect the result.
 */
export function canonicalArgs(parsed: Record<string, unknown>): string {
  const rendered = formatLaunchArgs(parsed);
  if (rendered === '(none)') return rendered;
  // Split on the whitespace between `--flag` groups, keeping each group whole:
  // a value token never starts with `--`, so regrouping is unambiguous except
  // for a value that legitimately starts with `--` (not produced by our
  // formatter for the known table; unknown flags always render as bare).
  const groups = rendered.split(/\s+(?=--)/);
  groups.sort();
  return groups.join(' ');
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * True when a peer described by `specArgs` (the spec's `args` string) matches a
 * live instance whose published args string is `publishedArgs`.
 *
 * Comparison is on the key-sorted canonical form. A `***` on EITHER side is a
 * wildcard for that flag's value, so a spec that omits a secret still matches a
 * peer that was launched with one (and vice versa).
 */
export function argsMatch(
  publishedArgs: string | null | undefined,
  specArgs: string | null | undefined,
): boolean {
  const a = canonicalGroupMap(parseArgString(publishedArgs));
  const b = canonicalGroupMap(parseArgString(specArgs));
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of keys) {
    const value = a.get(key);
    const other = b.get(key);
    if (value === undefined || other === undefined) {
      // A redacted secret may legitimately be omitted from one side. Missing
      // non-secret flags remain a real configuration difference.
      const present = value ?? other;
      if (present !== REDACTED) return false;
      continue;
    }
    if (value === REDACTED || other === REDACTED) continue;
    if (value !== other) return false;
  }
  return true;
}

/**
 * Index rendered `--flag [value]` groups by flag name for wildcard-aware
 * comparison. Positionals (`_`) are ignored — they do not belong in a spec.
 *
 * A REPEATED flag contributes every one of its rendered groups to the key,
 * and the key is collapsed to a multiplicity string by keyMultiplicity(),
 * so a peer launched with `--f a --f b` does not match a spec that says
 * only `--f b` (or a bare `--f`).
 */
function canonicalGroupMap(parsed: ParsedArgs): Map<string, string> {
  // Collect all rendered groups per flag name BEFORE collapsing to the
  // comparable value: multiplicity is part of a flag's identity.
  const perKey = new Map<string, string[]>();
  for (const group of canonicalArgs(parsed).split(/\s+(?=--)/)) {
    if (group === '(none)' || !group.startsWith('--')) continue;
    const sp = group.indexOf(' ');
    const rawKey = (sp === -1 ? group : group.slice(0, sp)).slice(2);
    // Fold short aliases (`v` → `verbose`) so a published minimist alias pair
    // (`--v --verbose`) collapses to the same single key the spec renders.
    const key = canonicalFlagName(rawKey);
    // Skip launcher-managed flags (e.g. --session-id): they are injected at
    // spawn time and never authored in a spec, so they must not affect match.
    if (LAUNCHER_FLAGS.includes(key)) continue;
    const value = sp === -1 ? '' : group.slice(sp + 1);
    const seen = perKey.get(key);
    if (seen) seen.push(value);
    else perKey.set(key, [value]);
  }
  const map = new Map<string, string>();
  for (const [key, values] of perKey) map.set(key, keyMultiplicity(values));
  return map;
}

/**
 * Collapse every rendered group of ONE flag into the value its key compares
 * as.
 *
 *   - Any `***` group (a redacted secret) makes the WHOLE key a wildcard, so
 *     a spec that omits a secret still matches a peer launched with one even
 *     when that secret flag repeats.
 *   - Otherwise the DISTINCT values join in the order canonicalArgs emitted
 *     them (bare booleans render as `true` inside a join so they stay visible
 *     next to value repeats). Identical repeats collapse: an alias pair
 *     (`-v` plus `--verbose`) folds to one repeat of the same key, and
 *     repeating the identical value twice adds no runtime state — while
 *     DIFFERENT repeats are preserved, because that is the multiplicity the
 *     comparison exists to detect.
 *   - A single value keeps its bare/`value` rendering, so specs authored for
 *     the pre-multiplicity format compare unchanged.
 */
function keyMultiplicity(values: string[]): string {
  if (values.includes(REDACTED)) return REDACTED;
  const distinct = [...new Set(values)];
  if (distinct.length === 1) return distinct[0];
  return distinct.map((v) => (v === '' ? 'true' : v)).join(', ');
}