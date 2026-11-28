/**
 * magic-query-rules.test.ts — which 魔法查询 rows a backend can serve.
 *
 * `/reload` respawns the Lead through the Coordinator, and a headless `--daemon`
 * Lead has none — the backend refuses it (src/slashes/reload.ts prints "Not
 * available in daemon mode"). The Web UI must therefore GREY the row out instead
 * of offering a button that silently does nothing. These tests pin the single
 * decision both the dialog (`:disabled`, click handler) and the composer
 * (`runMagicQuery`) call.
 */
import { describe, it, expect } from 'vite-plus/test';
import { resolveUnavailable, isMagicQueryRunnable } from '../../web/src/magic-query-rules.js';

describe('magic-query-rules — /reload availability', () => {
  it('greys /reload out on a daemon (persistent) backend, with a reason', () => {
    const reason = resolveUnavailable({ query: '/reload', persistent: true, persistentKnown: true });
    expect(reason).toBeTruthy();
    expect(reason).toContain('daemon');
    expect(isMagicQueryRunnable({ query: '/reload', persistent: true, persistentKnown: true })).toBe(false);
  });

  it('keeps /reload runnable on an interactive (non-persistent) backend', () => {
    expect(resolveUnavailable({ query: '/reload', persistent: false, persistentKnown: true })).toBeNull();
    expect(isMagicQueryRunnable({ query: '/reload', persistent: false, persistentKnown: true })).toBe(true);
  });

  it('does NOT guess before /config has answered: the store default is not a verdict', () => {
    // `persistent` defaults to false, which is indistinguishable from a genuine
    // "interactive backend" — so an unknown backend must not be a reason to
    // disable (the row's own `runnable` gate still blocks execution).
    expect(resolveUnavailable({ query: '/reload', persistent: true, persistentKnown: false })).toBeNull();
  });

  it('never gates a Coordinator-free command', () => {
    for (const query of ['/compact', '/clear', '/auto-commit']) {
      expect(resolveUnavailable({ query, persistent: true, persistentKnown: true })).toBeNull();
    }
  });

  it('a reason is only ever produced together with a false runnable verdict', () => {
    const cases = [
      { query: '/reload', persistent: true, persistentKnown: true },
      { query: '/reload', persistent: false, persistentKnown: true },
      { query: '/reload', persistent: true, persistentKnown: false },
      { query: '/compact', persistent: true, persistentKnown: true }
    ];
    for (const c of cases) {
      expect(isMagicQueryRunnable(c)).toBe(resolveUnavailable(c) === null);
    }
  });
});
