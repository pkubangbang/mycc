/**
 * screen.test.ts - Tests for the screen tool's detectEnvironment memoization
 *
 * dir-5 弱点1: detectEnvironment spawns `which`/`where` via execSync for
 * each candidate screenshot tool on every screen call. The environment
 * (OS, display server, desktop, installed tools) is process-stable, so the
 * expensive probe is cached at module level after the first call. The
 * cache-control is surfaced as a first-class `probe` tool argument:
 *   - probe=false (default): reuse the cached environment, no new probes
 *   - probe=true: force a fresh `which`/`where` round (e.g. after a tool
 *     was installed mid-session), refreshing the cache
 *
 * The screenshot capture path and imgDescribe are NOT exercised here —
 * detectEnvironment is the unit under test. execSync is mocked so no real
 * child processes are spawned. Assertions are platform-agnostic: they count
 * the *round* of probing (one round = one detectEnvironment invocation's
 * worth of `which`/`where` calls), not a fixed candidate count.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock child_process.execSync so no real `which`/`where`/capture runs.
// Returning a non-empty buffer makes every probe "succeed" so the candidate
// list is populated and the env result is stable/cached.
vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('/usr/local/bin/found')),
}));

import { execSync } from 'child_process';
import { screenTool, resetEnvCacheForTests } from '../../tools/screen.js';
import { createMockContext, createTempDir, removeTempDir } from './test-utils.js';

describe('screenTool detectEnvironment memoization + probe arg', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    resetEnvCacheForTests();
    vi.mocked(execSync).mockClear();
  });

  afterEach(() => {
    removeTempDir(tempDir);
    resetEnvCacheForTests();
    vi.restoreAllMocks();
  });

  /** Count only env-detection probe calls (`where <cmd>` / `which <cmd>`). */
  function envProbeCalls(): number {
    return vi.mocked(execSync).mock.calls.filter((args) => {
      const cmd = String(args[0] ?? '');
      return cmd.startsWith('where ') || cmd.startsWith('which ');
    }).length;
  }

  it('probes the environment exactly once across multiple screen calls (probe default false reuses cache)', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    // First call: detectEnvironment probes the candidate list.
    await screenTool.handler(ctx, {});
    const firstRoundProbes = envProbeCalls();
    expect(firstRoundProbes).toBeGreaterThan(0);

    // Calls 2 and 3 (probe defaults to false) must reuse the cached result.
    await screenTool.handler(ctx, {});
    await screenTool.handler(ctx, {});

    expect(envProbeCalls()).toBe(firstRoundProbes);
  });

  it('re-probes when probe=true is passed (e.g. after a tool was installed mid-session)', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    await screenTool.handler(ctx, {});
    const firstRoundProbes = envProbeCalls();
    expect(firstRoundProbes).toBeGreaterThan(0);

    // probe=true must bypass the cache and run a fresh round of probes.
    vi.mocked(execSync).mockClear();
    await screenTool.handler(ctx, { probe: true });
    const reprobeCalls = envProbeCalls();
    expect(reprobeCalls).toBe(firstRoundProbes);

    // A subsequent default call (probe=false) must reuse the refreshed
    // cache — no new probes.
    vi.mocked(execSync).mockClear();
    await screenTool.handler(ctx, {});
    expect(envProbeCalls()).toBe(0);
  });

  it('accepts probe=false explicitly and still reuses the cache', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    await screenTool.handler(ctx, { probe: false });
    const firstRoundProbes = envProbeCalls();
    expect(firstRoundProbes).toBeGreaterThan(0);

    vi.mocked(execSync).mockClear();
    await screenTool.handler(ctx, { probe: false });
    expect(envProbeCalls()).toBe(0);
  });

  it('declares the probe property in its input schema', () => {
    const props = screenTool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('probe');
    const probe = props.probe as { type: string };
    expect(probe.type).toBe('boolean');
  });
});