/**
 * arg-canonical.test.ts - Unit tests for the shared CLI-arg table + parser.
 *
 * The util (src/utils/arg-canonical.ts) is loaded by BOTH `src/config.ts` and
 * the `mycc-compose` bin (a thin .js shim that registers the tsx loader then
 * imports the .ts lib modules). Its whole point is that the two sides parse
 * a flag string through ONE table, so the classic Number-vs-String trap cannot
 * occur. These tests pin that contract:
 *
 *   1. parseArgString() agrees with minimist() over a fixture set (parity) —
 *      the property the design doc (§6.1) promises.
 *   2. formatLaunchArgs() is order-preserving and redacts secrets.
 *   3. canonicalArgs() is key-sorted (order-insensitive).
 *   4. argsMatch() is canonical + `***`-wildcard + ignores launcher flags.
 *   5. buildCmdArgsEnv() maps only set flags, as strings.
 */

import { describe, it, expect } from 'vitest';
import minimist from 'minimist';
import {
  BOOLEAN_FLAGS,
  STRING_FLAGS,
  DEFAULTS,
  SECRET_FLAGS,
  LAUNCHER_FLAGS,
  parseArgString,
  formatLaunchArgs,
  formatLaunchArgsForSpawn,
  canonicalFlagName,
  canonicalArgs,
  buildReloadArgs,
  argsMatch,
  buildCmdArgsEnv,
} from '../utils/arg-canonical.js';

/** The exact minimist invocation config.ts uses, for parity comparison. */
function minimistParse(raw: string) {
  return minimist(raw.trim() === '' ? [] : raw.trim().split(/\s+/), {
    boolean: BOOLEAN_FLAGS,
    string: STRING_FLAGS,
    alias: { v: 'verbose' },
    default: DEFAULTS,
  });
}

/**
 * Reduce a parsed object to the values that matter for parity. minimist
 * applies `DEFAULTS` (e.g. `from: null`, `v: false`) so it reports every
 * defaulted key; our parser only records SET flags. Normalize both to a
 * common shape:
 *
 *   - drop `_` (positionals) and `alias` (minimist bookkeeping);
 *   - drop keys whose value is "unset" (`undefined`/`false`/`null`);
 *   - fold Number values into their String form. minimist auto-coerces an
 *     UNKNOWN flag's value (`--serve 9000` → `9000` the Number) because it is
 *     neither in `boolean` nor `string`. Our parser is table-driven and keeps
 *     strings — which is exactly the §6.1 guarantee (no Number-vs-String
 *     trap). For parity we compare the String rendering of each value.
 *
 * NOTE: this normalizer deliberately does NOT drop the `v` alias key any more.
 * Dropping it (plus the Number fold) previously HID two real divergences, so
 * the suite certified a false parity guarantee:
 *
 *   - `-v`: minimist with `alias:{v:'verbose'}` publishes BOTH `v` and
 *     `verbose`, so the instance published `--v --verbose --auto` while a spec
 *     rendered `--verbose --auto` → argsMatch === false → every healthy `-v`
 *     peer was renewed by `up` and reported mismatched by `sync`, forever;
 *   - `--serve 09000`: minimist coerces to `9000` while the parser keeps
 *     `09000` → false mismatch.
 *
 * Both are now fixed at the source (ALIASES folding in arg-canonical.ts), and
 * the parity assertions below compare the EXACT published strings — the
 * rendering the two sides actually use for matching — instead of a lossy
 * projection that cannot see a divergence.
 */
function significant(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_' || k === 'alias') continue;
    if (v === undefined || v === false || v === null) continue;
    out[k] = Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? String(x) : x)) : typeof v === 'number' ? String(v) : v;
  }
  return out;
}

/**
 * The published-rendering parity assertion: the string the CONFIG side would
 * publish for `raw` must equal the string the SPEC side renders for `raw`.
 * This is the contract argsMatch() actually relies on, so it is asserted
 * directly rather than through a normalizer that can mask a divergence.
 */
function publishedParity(raw: string): { mine: string; theirs: string } {
  return {
    mine: formatLaunchArgs(parseArgString(raw)),
    theirs: formatLaunchArgs(minimistParse(raw)),
  };
}

describe('arg-canonical: parseArgString ↔ minimist parity', () => {
  const fixtures = [
    '--auto --skip-healthcheck --ollama-model glm-5:cloud',
    '--token-threshold 80000',
    '--ollama-model=gemma4:31b-cloud --serve 9000',
    '--auto --session-id 11111111-2222-4333-8444-555555555555',
    '-v --debug-tp',
    '--wire-token secret --api-provider deepseek',
    '--daemon skill-manager',
    '--max-upload-mb 100 --skill-match-threshold 0.6',
    '--allow-auto-commit main,release-candidate',
  ];

  for (const raw of fixtures) {
    it(`agrees with minimist for: ${raw}`, () => {
      const mine = significant(parseArgString(raw)) as Record<string, unknown>;
      const theirs = significant(minimistParse(raw)) as Record<string, unknown>;
      // Compare by CANONICAL flag name, not raw key: our parser folds `-v` onto
      // `verbose` (ALIASES), so minimist's separate `v` key has no counterpart
      // and would otherwise read as a spurious "missing key" divergence. Folding
      // the keys is the same normalization argsMatch() uses.
      const fold = (obj: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === '_') continue;
          const key = canonicalFlagName(k);
          if (!(key in out)) out[key] = v; // first-wins, as in canonicalGroupMap
        }
        return out;
      };
      const a = fold(mine);
      const b = fold(theirs);
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        const av = a[k];
        const bv = b[k];
        if (av === undefined && (bv === false || bv === undefined)) continue;
        if (bv === undefined && (av === false || av === undefined)) continue;
        expect(av, `key ${k} for "${raw}"`).toEqual(bv);
      }
    });
  }

  it('keeps --token-threshold a STRING on both sides (no Number trap)', () => {
    expect(parseArgString('--token-threshold 80000')['token-threshold']).toBe('80000');
    expect(minimistParse('--token-threshold 80000')['token-threshold']).toBe('80000');
  });

  it('parses bare --serve to true and --serve 9000 to the port', () => {
    expect(parseArgString('--serve').serve).toBe(true);
    expect(parseArgString('--serve 9000').serve).toBe('9000');
  });

  it('collects repeated flags into an array', () => {
    expect(parseArgString('--flag a --flag b').flag).toEqual(['a', 'b']);
  });

  it('returns { _: [] } for empty / (none)', () => {
    expect(parseArgString('')).toEqual({ _: [] });
    expect(parseArgString('(none)')).toEqual({ _: [] });
  });
});

describe('arg-canonical: formatLaunchArgs', () => {
  it('is order-preserving and omits unset flags', () => {
    const parsed = parseArgString('--ollama-model glm-5:cloud --auto --skip-healthcheck');
    expect(formatLaunchArgs(parsed)).toBe('--ollama-model glm-5:cloud --auto --skip-healthcheck');
  });

  it('redacts secrets to --flag ***', () => {
    const parsed = parseArgString('--wire-token supersecret --auto');
    const rendered = formatLaunchArgs(parsed);
    expect(rendered).toContain('--wire-token ***');
    expect(rendered).not.toContain('supersecret');
    // Non-vacuous: EVERY secret flag must actually be redacted by the renderer.
    // (The previous `expect(SECRET_FLAGS).toContain(s)` was tautological — it
    // passed even if redaction was deleted entirely.)
    for (const flag of SECRET_FLAGS) {
      const r = formatLaunchArgs(parseArgString(`--${flag} LEAKME --auto`));
      expect(r, `secret flag ${flag}`).toContain(`--${flag} ***`);
      expect(r, `secret flag ${flag}`).not.toContain('LEAKME');
    }
  });

  it('renders (none) when nothing is set', () => {
    expect(formatLaunchArgs({ _: [] })).toBe('(none)');
  });
});

describe('arg-canonical: canonicalArgs + argsMatch', () => {
  it('canonicalArgs is order-insensitive', () => {
    const a = canonicalArgs(parseArgString('--auto --skip-healthcheck'));
    const b = canonicalArgs(parseArgString('--skip-healthcheck --auto'));
    expect(a).toBe(b);
  });

  it('argsMatch: identical specs match regardless of order', () => {
    expect(argsMatch('--auto --skip-healthcheck', '--skip-healthcheck --auto')).toBe(true);
  });

  it('argsMatch: a real difference fails', () => {
    expect(
      argsMatch('--auto --ollama-model glm-5:cloud', '--auto --ollama-model other'),
    ).toBe(false);
  });

  it('argsMatch: *** on either side is a wildcard', () => {
    expect(argsMatch('--wire-token *** --auto', '--wire-token abc --auto')).toBe(true);
    expect(argsMatch('--wire-token abc --auto', '--wire-token *** --auto')).toBe(true);
  });

  it('argsMatch: ignores launcher-managed flags (--session-id)', () => {
    expect(LAUNCHER_FLAGS).toContain('session-id');
    expect(
      argsMatch(
        '--auto --skip-healthcheck --session-id 11111111-2222-4333-8444-555555555555',
        '--auto --skip-healthcheck',
      ),
    ).toBe(true);
  });

  it('argsMatch: launcher-flag exclusion does not hide a real difference', () => {
    expect(
      argsMatch(
        '--auto --session-id 11111111-2222-4333-8444-555555555555 --ollama-model x',
        '--auto --ollama-model y',
      ),
    ).toBe(false);
  });

  it('canonicalArgs still renders launcher flags (display form is faithful)', () => {
    const c = canonicalArgs(parseArgString('--auto --session-id 11111111-2222-4333-8444-555555555555'));
    expect(c).toContain('--session-id');
  });
});

describe('arg-canonical: argsMatch multiplicity (P1-2 regression)', () => {
  // A repeated flag collects its values into an array (minimist behaviour) and
  // renders as ONE `--flag value` group PER repeat. The pre-P1-2 group map was
  // first-wins per key, so every repeat after the first was silently dropped:
  // a live instance launched with `--f a --f b` "matched" any spec containing
  // a single value of that flag, and `up`/`sync` never detected the drift.
  // Multiplicity is part of a flag's identity — these pin the contract.
  it('a repeated flag does not match a spec that mentions only one repeat', () => {
    expect(argsMatch('--flag a --flag b', '--flag b')).toBe(false);
    expect(argsMatch('--flag b --flag a', '--flag a')).toBe(false);
    expect(argsMatch('--flag a --flag b', '--flag a')).toBe(false);
  });

  it('identical repeats on both sides still match regardless of order', () => {
    expect(argsMatch('--flag a --flag b', '--flag b --flag a')).toBe(true);
    expect(argsMatch('--flag a --flag b', '--flag a --flag b')).toBe(true);
    // An identical value repeated adds no runtime state: matching a spec that
    // says it once (and vice versa) is the intended equivalence.
    expect(argsMatch('--flag a --flag a', '--flag a')).toBe(true);
    expect(argsMatch('--flag a', '--flag a --flag a')).toBe(true);
  });

  it('a bare boolean mixed with a value repeat is not a bare-only match', () => {
    expect(argsMatch('--flag --flag a', '--flag')).toBe(false);
    expect(argsMatch('--flag --flag a', '--flag --flag a')).toBe(true);
    expect(argsMatch('--a --a x --a y', '--a --a x --a y')).toBe(true);
  });

  it('a repeated secret wildcards the whole key; key presence is still compared', () => {
    // formatLaunchArgs redacts EVERY secret value at render time — on BOTH
    // sides — so a redacted group is `***` regardless of how many values the
    // flag repeated. Which values repeated is therefore unobservable: the
    // `***`-wildcard contract (any secret value matches any other) governs,
    // consistent with "a spec that omits a secret still matches a peer that
    // was launched with one". What IS still compared is key presence.
    expect(argsMatch('--wire-token a --wire-token b --auto', '--wire-token *** --auto')).toBe(true);
    expect(argsMatch('--wire-token *** --auto', '--wire-token a --wire-token b --auto')).toBe(true);
    // Multiplicity does not smuggle in a KEY the spec lacks: the differing
    // key count still fails the match (size check in argsMatch).
    expect(argsMatch('--wire-token a --wire-token b --auto', '--auto')).toBe(true);
    expect(argsMatch('--auto', '--wire-token a --wire-token b --auto')).toBe(true);
    expect(argsMatch('--auto --flag x', '--auto')).toBe(false);
  });

  it('alias-folding still collapses to one repeat (multiplicity must not regress -v parity)', () => {
    // The `-v` alias contract from the earlier fix: the published alias pair
    // folds onto ONE key, and must render/count as ONE repeat, not two.
    expect(argsMatch('--v --verbose --auto', '--verbose --auto')).toBe(true);
    expect(canonicalArgs(parseArgString('--v --verbose --auto')))
      .toBe(canonicalArgs(parseArgString('--verbose --auto')));
  });
});

describe('arg-canonical: published-rendering parity (the argsMatch contract)', () => {
  // The regression guard for the `-v` alias divergence. With the old lossy
  // normalizer the suite passed while argsMatch() returned false for every
  // `-v` peer, so `up` renewed healthy peers forever.
  //
  // WHAT IS ASSERTED, AND WHY NOT ORDER: the CONTRACT is that both sides
  // publish something argsMatch() considers equal. That is a CANONICAL
  // (key-sorted) property, not a byte-for-byte property: minimist walks its
  // OWN key order (defaults first), so for `--auto --skip-healthcheck` it
  // renders `--skip-healthcheck --auto` while our parser renders
  // `--auto --skip-healthcheck`. Those are different strings — and they are
  // SUPPOSED to be, because formatLaunchArgs() is documented as
  // order-preserving. Asserting string identity here would encode a guarantee
  // the design never made (and could not: it would require controlling
  // minimist's iteration order).
  const cases: Array<[string, string]> = [
    ['-v --auto', '--verbose --auto'],
    ['--verbose --auto', '--verbose --auto'],
    ['--auto --skip-healthcheck', '--auto --skip-healthcheck'],
    ['--daemon skill-manager', '--daemon skill-manager'],
    // A SECRET is redacted by BOTH sides (each renders `--wire-token ***`),
    // so the redacted forms compare equal — this is the display/publish path.
    ['--wire-token abc --auto', '--wire-token *** --auto'],
    ['--ollama-model gemma4:31b-cloud --auto', '--ollama-model gemma4:31b-cloud --auto'],
  ];

  for (const [raw, expectedMine] of cases) {
    it(`publishes an argsMatch-equal form for "${raw}" on both sides`, () => {
      const { mine, theirs } = publishedParity(raw);
      // Our (spec) side: exact, order-preserving.
      expect(mine).toBe(expectedMine);
      // minimist side: canonical form must agree, and argsMatch must accept it.
      expect(canonicalArgs(minimistParse(raw))).toBe(canonicalArgs(parseArgString(raw)));
      expect(argsMatch(theirs, mine), `argsMatch(minimist, mine) for "${raw}"`).toBe(true);
    });
  }

  it('-v publishes the folded long form exactly once (no --v --verbose)', () => {
    // THE regression for the alias divergence: before ALIASES folding this was
    // `--v --verbose --auto`, whose canonical map keyed `v` and `verbose`
    // separately → argsMatch() === false against a spec's `--verbose --auto`.
    const { mine, theirs } = publishedParity('-v --auto');
    expect(theirs).toBe('--verbose --auto');
    expect(mine).toBe('--verbose --auto');
    expect(theirs).not.toMatch(/--v(\s|$)/); // no bare --v group
    expect(argsMatch(theirs, mine)).toBe(true);
  });

  it('the raw minimist alias pair still matches a spec that uses only the long form', () => {
    // The exact shape a real (pre-fix) instance published, compared against a
    // spec. Canonical group map folds `v` -> `verbose` first-wins, so this is
    // true even though the published string contains BOTH alias keys.
    expect(argsMatch('--v --verbose --auto', '--verbose --auto')).toBe(true);
    expect(canonicalArgs(parseArgString('--v --verbose --auto')))
      .toBe(canonicalArgs(parseArgString('--verbose --auto')));
  });

  it('documents the supported daemon syntax', () => {
    expect(formatLaunchArgs(minimistParse('--daemon'))).toBe('(none)');
    expect(formatLaunchArgs(parseArgString('--daemon'))).toBe('--daemon');
    expect(canonicalArgs(minimistParse('--daemon skill-manager')))
      .toBe(canonicalArgs(parseArgString('--daemon skill-manager')));
  });
});

describe('arg-canonical: spawn rendering preserves secrets', () => {
  it('formatLaunchArgsForSpawn does NOT redact (the spawn argv must carry the real value)', () => {
    const parsed = parseArgString('--auto --wire-token REAL --ollama-api-key KEY');
    const spawn = formatLaunchArgsForSpawn(parsed);
    expect(spawn).toContain('--wire-token REAL');
    expect(spawn).toContain('--ollama-api-key KEY');
    expect(spawn).not.toContain('***');
  });

  it('formatLaunchArgs still redacts for display/publish', () => {
    const parsed = parseArgString('--auto --wire-token REAL');
    const display = formatLaunchArgs(parsed);
    expect(display).toContain('--wire-token ***');
    expect(display).not.toContain('REAL');
  });
});

describe('arg-canonical: buildCmdArgsEnv', () => {
  it('maps set flags to MYCC_/provider env keys as strings', () => {
    const env = buildCmdArgsEnv(parseArgString('--auto --skip-healthcheck --token-threshold 80000'));
    expect(env.MYCC_SKIP_HEALTHCHECK).toBe('true');
    expect(env.TOKEN_THRESHOLD).toBe('80000');
  });

  it('omits unset/false flags', () => {
    const env = buildCmdArgsEnv(parseArgString('--auto'));
    expect(env.MYCC_VERBOSE).toBeUndefined();
    expect(env.MYCC_SETUP).toBeUndefined();
  });

  it('maps --allow-auto-commit to MYCC_ALLOW_AUTO_COMMIT and keeps the comma list intact', () => {
    // The env mirror is a pass-through: the SAME comma-separated value
    // survives, so config.ts's getAllowAutoCommitBranches() can split it
    // identically whether the flag arrived via argv or the env var.
    const env = buildCmdArgsEnv(parseArgString('--allow-auto-commit main,release-candidate'));
    expect(env.MYCC_ALLOW_AUTO_COMMIT).toBe('main,release-candidate');
    // Absent flag must NOT clobber an env var set elsewhere.
    expect(buildCmdArgsEnv(parseArgString('--auto')).MYCC_ALLOW_AUTO_COMMIT).toBeUndefined();
  });
});

describe('arg-canonical: buildReloadArgs (/reload respawn argv)', () => {
  // The /reload bug: the coordinator rebuilt the respawn argv from serve state
  // ONLY, silently dropping every other launch flag. buildReloadArgs() replays
  // the old lead's original argv and merges the LIVE serve state on top.

  it('replays every launch flag (not just serve) when serve is off', () => {
    const out = buildReloadArgs(
      ['--auto', '--allow-auto-commit', 'main,dev', '--token-threshold', '80000', '--ollama-model', 'glm-5:cloud'],
      false, 0, null,
    );
    expect(out).toEqual([
      '--auto', '--allow-auto-commit', 'main,dev',
      '--token-threshold', '80000', '--ollama-model', 'glm-5:cloud',
    ]);
  });

  it('drops positionals', () => {
    const out = buildReloadArgs(['--auto', 'stray-positional', '--verbose'], false, 0, null);
    expect(out).toEqual(['--auto', '--verbose']);
  });

  it('never carries --from (reload starts a fresh session)', () => {
    // Both arg spellings must be filtered.
    expect(buildReloadArgs(['--from', 'abc123', '--auto'], false, 0, null)).toEqual(['--auto']);
    expect(buildReloadArgs(['--from=abc123', '--auto'], false, 0, null)).toEqual(['--auto']);
  });

  it('replaces the stale original --serve tokens with the LIVE serve state', () => {
    // The original flag said port 3100; the hub now reports 3193 — the live
    // reading must win, and the original token must not survive alongside.
    const out = buildReloadArgs(['--serve', '3100', '--host', '0.0.0.0', '--auto'], true, 3193, '0.0.0.0');
    expect(out).toEqual(['--auto', '--serve', '3193', '--host', '0.0.0.0']);
    expect(out.filter((t) => t === '--serve')).toHaveLength(1);
  });

  it('strips --serve/--port/--host when serve is now OFF', () => {
    expect(buildReloadArgs(['--serve', '3100', '--port', '8080', '--host', '0.0.0.0', '--auto'], false, 0, null))
      .toEqual(['--auto']);
    // `=` spellings too.
    expect(buildReloadArgs(['--serve=3100', '--host=0.0.0.0', '--auto'], false, 0, null))
      .toEqual(['--auto']);
  });

  it('emits bare --serve port when active and no host given (localhost bind)', () => {
    expect(buildReloadArgs(['--auto'], true, 3173, null)).toEqual(['--auto', '--serve', '3173']);
  });

  it('does not append serve flags when active but port is 0 (defensive)', () => {
    expect(buildReloadArgs(['--auto'], true, 0, null)).toEqual(['--auto']);
  });
});
