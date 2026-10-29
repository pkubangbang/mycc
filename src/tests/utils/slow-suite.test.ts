/**
 * slow-suite.test.ts - the mute gate must never be applied to a main-loop suite.
 *
 * `mutedSlowSuite(import.meta.url)` is used as `describe.skipIf(...)` by the
 * relatively stable, environment-bound suites (grep over the real repo, CLI
 * boots, lock TTL waits). This test pins the guard's teeth: a file under a
 * main-loop directory must THROW at collection time rather than silently
 * shrinking the default run.
 */
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'url';
import * as path from 'path';
import { mutedSlowSuite, assertMuteAllowed } from './slow-suite.js';

const u = (p: string) => pathToFileURL(path.resolve(p)).href;

describe('mutedSlowSuite — main-loop suites are refused', () => {
  it.each([
    ['loop', 'src/tests/loop/states/llm-esc.test.ts'],
    ['loop root', 'src/tests/loop/state-machine.test.tsxx'],
    ['agent-io', 'src/tests/agent-io/agent-exec.test.ts'],
    ['state-machine', 'src/tests/state-machine/state-machine.test.ts'],
    ['hook', 'src/tests/hook/hook-executor.test.ts'],
    ['engine', 'src/tests/engine/compact.test.ts'],
  ])('refuses a %s suite', (_label, file) => {
    expect(() => assertMuteAllowed(u(file))).toThrow(/refusing to mute/);
    expect(() => mutedSlowSuite(u(file))).toThrow(/main loop/);
  });

  it('accepts a stable, environment-bound suite', () => {
    expect(() => assertMuteAllowed(u('src/tests/utils/grep-search.test.ts'))).not.toThrow();
    expect(() => assertMuteAllowed(u('src/tests/file-lock.test.ts'))).not.toThrow();
    // path separators from Windows-style URLs must not dodge the matching
    expect(() => assertMuteAllowed(u('src/tests/utils/slow-suite.test.ts'))).not.toThrow();
  });

  it('is muted by default and runs when RUN_SLOW=1 or CI=true', () => {
    const file = u('src/tests/utils/grep-search.test.ts');
    const saved = { RUN_SLOW: process.env.RUN_SLOW, CI: process.env.CI };
    try {
      delete process.env.RUN_SLOW;
      delete process.env.CI;
      expect(mutedSlowSuite(file)).toBe(true);
      process.env.RUN_SLOW = '1';
      expect(mutedSlowSuite(file)).toBe(false);
      delete process.env.RUN_SLOW;
      process.env.CI = 'true';
      expect(mutedSlowSuite(file)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('the stable suites that import the gate are all in the allowed set', () => {
    // If a loop-owned file ever imported the gate, its own collection would
    // throw. This asserts the concrete allow-list stays what mute-policy.md says.
    for (const f of [
      'src/tests/utils/grep-search.test.ts',
      'src/tests/file-lock.test.ts',
      'src/tests/mycc-stop.test.ts',
      'src/tests/plain-output.test.ts',
    ]) {
      expect(() => assertMuteAllowed(u(f)), f).not.toThrow();
    }
  });
});
