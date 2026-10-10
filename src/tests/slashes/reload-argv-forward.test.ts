/**
 * reload-argv-forward.test.ts - /reload dispatch-site argv forwarding (P1 #2).
 *
 * THE BUG: src/slashes/reload.ts built the 'reload' IPC payload with
 *   process.argv.slice(2).filter((a) => a.startsWith('-'))
 * which drops every SEPARATE flag VALUE — a token that does not itself start
 * with '-'. So `mycc --max-upload-mb 20` forwarded only `['--max-upload-mb']`;
 * the respawned Lead parsed a bare flag → minimist `true` → getMaxUploadMb()
 * = Number(true) = 1, silently turning 20 MB into 1 MB (the same class of bug
 * for EVERY STRING_FLAGS value, e.g. `--autofly <n>`).
 *
 * THE FIX: the dispatch site forwards the COMPLETE `process.argv.slice(2)` via
 * collectReloadLeadArgs(), and the Coordinator-side buildReloadArgs() — which
 * already parses `--flag value` correctly (consuming the next non-flag token) —
 * does all positional / `--from` / serve filtering.
 *
 * These tests exercise the EXACT end-to-end transformation the real code
 * performs:
 *
 *   process.argv
 *     --collectReloadLeadArgs()-->  IPC leadArgs
 *     --buildReloadArgs()-------->  respawn argv
 *
 * including a pin of the OLD lossy filter's behaviour, so a reintroduction of
 * a `startsWith('-')` pre-filter at the dispatch site fails here.
 */
import { describe, it, expect } from 'vitest';
import { collectReloadLeadArgs } from '../../slashes/reload.js';
import { buildReloadArgs, parseArgString } from '../../utils/arg-canonical.js';

/** Run the full dispatch → respawn transformation the way the real code does. */
function respawnArgv(
  argv: string[],
  serveActive = false,
  servePort = 0,
  serveHost: string | null = null,
): string[] {
  const leadArgs = collectReloadLeadArgs(argv);
  return buildReloadArgs(leadArgs, serveActive, servePort, serveHost);
}

describe('reload dispatch: collectReloadLeadArgs forwards value tokens (P1 #2)', () => {
  it('keeps a SEPARATE string-flag value (--max-upload-mb 20)', () => {
    // argv[0]=node, argv[1]=script — slice(2) is the flags.
    const argv = ['node', 'mycc', '--max-upload-mb', '20'];
    expect(collectReloadLeadArgs(argv)).toEqual(['--max-upload-mb', '20']);
  });

  it("keeps an --autofly <n> value (a STRING_FLAGS value that isn't a flag)", () => {
    const argv = ['node', 'mycc', '--autofly', '5'];
    expect(collectReloadLeadArgs(argv)).toEqual(['--autofly', '5']);
  });

  it('is an identity slice(2) — it does NOT drop non-flag tokens', () => {
    const argv = ['node', 'mycc', '--auto', 'stray-positional', '--token-threshold', '80000'];
    expect(collectReloadLeadArgs(argv)).toEqual([
      '--auto', 'stray-positional', '--token-threshold', '80000',
    ]);
  });
});

describe('reload dispatch: end-to-end respawn argv preserves flag values (P1 #2)', () => {
  it('--max-upload-mb 20 survives to the respawned argv (the exact reported bug)', () => {
    const out = respawnArgv(['node', 'mycc', '--max-upload-mb', '20']);
    expect(out).toEqual(['--max-upload-mb', '20']);
    // The respawned Lead must parse the limit as the NUMBER 20, not `true`
    // (which getMaxUploadMb() would coerce to Number(true) === 1).
    expect(parseArgString(out.join(' '))['max-upload-mb']).toBe('20');
  });

  it('--autofly 5 survives to the respawned argv', () => {
    const out = respawnArgv(['node', 'mycc', '--autofly', '5']);
    expect(out).toEqual(['--autofly', '5']);
    expect(parseArgString(out.join(' '))['autofly']).toBe('5');
  });

  it('mixed flags + values all survive, with serve state merged in', () => {
    const out = respawnArgv(
      ['node', 'mycc', '--auto', '--max-upload-mb', '20', '--autofly', '5', '--ollama-model', 'glm-5:cloud'],
      true, 3193, null,
    );
    expect(out).toEqual([
      '--auto', '--max-upload-mb', '20', '--autofly', '5', '--ollama-model', 'glm-5:cloud',
      '--serve', '3193',
    ]);
    const parsed = parseArgString(out.join(' '));
    expect(parsed['max-upload-mb']).toBe('20');
    expect(parsed['autofly']).toBe('5');
    expect(parsed['ollama-model']).toBe('glm-5:cloud');
  });

  it('still drops a stray positional and --from (buildReloadArgs owns filtering)', () => {
    const out = respawnArgv(['node', 'mycc', '--auto', 'stray', '--from', 'abc123', '--max-upload-mb', '20']);
    expect(out).toEqual(['--auto', '--max-upload-mb', '20']);
  });

  it('`=` spellings are preserved whole (no value token to lose)', () => {
    const out = respawnArgv(['node', 'mycc', '--max-upload-mb=20', '--auto']);
    expect(out).toEqual(['--max-upload-mb=20', '--auto']);
    expect(parseArgString(out.join(' '))['max-upload-mb']).toBe('20');
  });
});

describe('reload dispatch: the OLD lossy filter is pinned as broken (regression)', () => {
  // The exact pre-fix dispatch transform. If someone reintroduces this, the
  // value-loss is demonstrated here — the test documents WHY the identity
  // forward is required.
  const oldFilter = (argv: string[]): string[] =>
    argv.slice(2).filter((a) => a.startsWith('-'));

  it('the old filter dropped the 20 in --max-upload-mb 20', () => {
    const argv = ['node', 'mycc', '--max-upload-mb', '20'];
    expect(oldFilter(argv)).toEqual(['--max-upload-mb']);
    // And that bare flag poisons the limit: Number(true) === 1.
    const reparsed = parseArgString(oldFilter(argv).join(' '));
    expect(reparsed['max-upload-mb']).toBe(true);
    expect(Number(reparsed['max-upload-mb'])).toBe(1);
  });

  it('the fix (identity forward) keeps the value the old filter lost', () => {
    const argv = ['node', 'mycc', '--max-upload-mb', '20'];
    expect(collectReloadLeadArgs(argv)).not.toEqual(oldFilter(argv));
    expect(collectReloadLeadArgs(argv)).toContain('20');
  });
});
