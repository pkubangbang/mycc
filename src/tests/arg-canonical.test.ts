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

  it('DOCUMENTS a live minimist-side divergence: bare --daemon is dropped by minimist', () => {
    // minimist types `daemon` as a STRING flag, so a bare `--daemon` parses to
    // `""`; isUnset('') is true, so minimist's published form renders NOTHING.
    // Our parser was fixed to record `true` for a valueless string-flag, so the
    // spec side renders `--daemon`.
    //
    // This is NOT a mycc-introduced asymmetry: the compose launcher always
    // spawns with an EXPLICIT value or `--auto`, and `--daemon <skill>` (the
    // documented form) parses identically on both sides. The test pins the
    // asymmetry so it is a KNOWN, asserted fact rather than a silent trap —
    // if a future change makes the two agree, this test fails and tells us.
    expect(formatLaunchArgs(minimistParse('--daemon'))).toBe('(none)');
    expect(formatLaunchArgs(parseArgString('--daemon'))).toBe('--daemon');
    // ...but the documented `--daemon <skill>` form IS in parity:
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
});
