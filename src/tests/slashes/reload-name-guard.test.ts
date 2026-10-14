/**
 * reload-name-guard.test.ts - the compose-managed `/reload` refusal seam (S4a.3 / M2).
 *
 * WHY: a mycc-compose-managed peer is launched with `--name <group>:<peer>`.
 * `/reload` respawns the Lead WITHOUT the compose launcher's coordination,
 * which would orphan the channel files compose materialized and desync the
 * durable name↔sid mapping. The refusal guard must therefore detect a `--name`
 * token in the Lead's launch argv — at BOTH call sites:
 *   - the slash handler (src/slashes/reload.ts) → default process.argv.slice(2);
 *   - the coordinator reloadLead (src/index.ts) → its already-sliced leadArgs.
 *
 * THE SEAM: a SINGLE exported predicate `hasNameFlag(tokens)` whose argument is
 * a PRE-SLICED launch-token list (no `node <script>`). The default
 * (`process.argv.slice(2)`) lives INSIDE the default expression, never as a
 * body-level slice — otherwise the coordinator's explicit pre-sliced `leadArgs`
 * would be sliced a SECOND time and a leading `--name` would be silently
 * dropped. That double-slice regression is pinned below; it is exactly the
 * silent-veto class of bug this guard exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { hasNameFlag } from '../../slashes/reload.js';

describe('hasNameFlag: pre-sliced token list detects the compose --name', () => {
  it('true for a separate `--name <value>` pair', () => {
    expect(hasNameFlag(['--name', 'grp:p', '--auto'])).toBe(true);
  });

  it('true for the `--name=<value>` spelling', () => {
    expect(hasNameFlag(['--name=grp:p', '--auto'])).toBe(true);
  });

  it('true when `--name` is the LAST token (value consumed, or bare)', () => {
    expect(hasNameFlag(['--auto', '--name'])).toBe(true);
    expect(hasNameFlag(['--name'])).toBe(true);
  });

  it('false when there is no --name token', () => {
    expect(hasNameFlag(['--auto', '--skip-healthcheck'])).toBe(false);
    expect(hasNameFlag([])).toBe(false);
  });

  it('false when the --name STRING is only a flag VALUE (not a token itself)', () => {
    // The token is the bare string 'grp:x' — not '--name' nor '--name=…'.
    expect(hasNameFlag(['--ollama-model', 'grp:x', '--auto'])).toBe(false);
    // Even the literal token '--name' smuggled as SOME OTHER flag's value is a
    // bare token equal to '--name' and WOULD match — that is the M4 boundary,
    // documented (and pinned) in the dedicated boundary test below.
  });

  it('REGRESSION: an explicitly-passed pre-sliced array is NOT sliced twice', () => {
    // The default's slice(2) MUST live in the default expression: the
    // coordinator passes its own pre-sliced leadArgs, so a body-level slice(2)
    // would drop this leading '--name' and silently allow the forbidden reload.
    expect(hasNameFlag(['--name', 'grp:p', '--auto'])).toBe(true);
    // And a leading '--name=<value>' likewise survives.
    expect(hasNameFlag(['--name=grp:p', '--auto'])).toBe(true);
  });
});

describe('hasNameFlag M4 boundary: a string-flag VALUE that literally equals --name', () => {
  it('a bare `--name` smuggled as another flag\'s value IS detected (documented boundary)', () => {
    // parseArgString consumes the next non-flag token as a string flag's value,
    // so `--editor --name` yields editor='--name'; formatLaunchArgsForSpawn
    // RE-EMITS it as a separate `--editor --name` token pair. The spawned child
    // then carries a bare `--name` token — which hasNameFlag reads as the
    // compose marker. This is intentional defense-in-depth: the token IS
    // present in the child's argv, so refusing the reload is the SAFE reading
    // (a false refusal only blocks /reload for an instance whose own args
    // already look compose-managed). Pin it so the behaviour is deliberate.
    const tokens = ['--editor', '--name'];
    expect(hasNameFlag(tokens)).toBe(true);
  });
});
