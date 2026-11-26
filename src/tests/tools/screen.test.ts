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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Mock child_process.execSync so no real `which`/`where`/capture runs.
// Returning a non-empty buffer makes every probe "succeed" so the candidate
// list is populated and the env result is stable/cached.
//
// The capture command, though, must actually PRODUCE the PNG: `captureScreenshot`
// only reports success when the target file exists and is non-empty, and the
// baseline/diff path then reads those bytes. So the mock extracts the quoted
// `.png` path from the command it is handed and writes the fixture that
// `nextCapture` points at. Without this the handler bails out at "command ran
// but produced no output file" and neither imgDescribe nor the diff runs.
const captureState: { nextCapture: string } = { nextCapture: '' };
const FIXTURES = path.dirname(fileURLToPath(import.meta.url));

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    const target = /['"]([^'"]*mycc_screen_\d+\.png)['"]/.exec(String(cmd))?.[1];
    if (target && captureState.nextCapture) {
      fs.copyFileSync(captureState.nextCapture, target);
    }
    return Buffer.from('/usr/local/bin/found');
  })
}));

import { execSync } from 'child_process';
import { screenTool, resetEnvCacheForTests } from '../../tools/screen.js';
import { resetScreenBaselineForTests } from '../../utils/screen-diff.js';
import { createMockContext, createTempDir, removeTempDir, runTool, testSignal } from './test-utils.js';

describe('screenTool detectEnvironment memoization + probe arg', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    resetEnvCacheForTests();
    resetScreenBaselineForTests();
    captureState.nextCapture = '';
    vi.mocked(execSync).mockClear();
  });

  afterEach(() => {
    removeTempDir(tempDir);
    resetEnvCacheForTests();
    resetScreenBaselineForTests();
    captureState.nextCapture = '';
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
    await runTool(screenTool, ctx, {}, testSignal);
    const firstRoundProbes = envProbeCalls();
    expect(firstRoundProbes).toBeGreaterThan(0);

    // Calls 2 and 3 (probe defaults to false) must reuse the cached result.
    await runTool(screenTool, ctx, {}, testSignal);
    await runTool(screenTool, ctx, {}, testSignal);

    expect(envProbeCalls()).toBe(firstRoundProbes);
  });

  it('re-probes when probe=true is passed (e.g. after a tool was installed mid-session)', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    await runTool(screenTool, ctx, {}, testSignal);
    const firstRoundProbes = envProbeCalls();
    expect(firstRoundProbes).toBeGreaterThan(0);

    // probe=true must bypass the cache and run a fresh round of probes.
    vi.mocked(execSync).mockClear();
    await runTool(screenTool, ctx, { probe: true }, testSignal);
    const reprobeCalls = envProbeCalls();
    expect(reprobeCalls).toBe(firstRoundProbes);

    // A subsequent default call (probe=false) must reuse the refreshed
    // cache — no new probes.
    vi.mocked(execSync).mockClear();
    await runTool(screenTool, ctx, {}, testSignal);
    expect(envProbeCalls()).toBe(0);
  });

  it('accepts probe=false explicitly and still reuses the cache', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    await runTool(screenTool, ctx, { probe: false }, testSignal);
    const firstRoundProbes = envProbeCalls();
    expect(firstRoundProbes).toBeGreaterThan(0);

    vi.mocked(execSync).mockClear();
    await runTool(screenTool, ctx, { probe: false }, testSignal);
    expect(envProbeCalls()).toBe(0);
  });

  it('declares the probe property in its input schema', () => {
    const props = screenTool.input_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('probe');
    const probe = props.probe as { type: string };
    expect(probe.type).toBe('boolean');
  });
});

/**
 * Baseline diff: the second image handed to imgDescribe.
 *
 * The fixtures are real PNGs (1280x720, written by sharp at build time) so the
 * diff runs its real code path — no sharp mocking, which would test the mock.
 * Their identical ratios are DERIVED from their construction, not tuned to the
 * implementation: `_identical` = 1.0, `_low` = 1 - 720/921600 = 0.99922,
 * `_high` = 1 - 184320/921600 = 0.80. All sit above the 15% threshold except
 * the below-threshold case, which is built inline.
 */
describe('screenTool baseline diff', () => {
  let tempDir: string;

  const fixture = (name: string) => path.join(FIXTURES, `__fixture_screen_${name}.png`);

  /** The 4th argument imgDescribe was called with (undefined when absent). */
  function secondImageArg(ctx: ReturnType<typeof createMockContext>): string | undefined {
    const call = vi.mocked(ctx.core.imgDescribe).mock.calls.at(-1);
    return call?.[3];
  }

  beforeEach(() => {
    tempDir = createTempDir();
    resetEnvCacheForTests();
    resetScreenBaselineForTests();
    captureState.nextCapture = fixture('identical');
    vi.mocked(execSync).mockClear();
  });

  afterEach(() => {
    removeTempDir(tempDir);
    resetEnvCacheForTests();
    resetScreenBaselineForTests();
    captureState.nextCapture = '';
    vi.restoreAllMocks();
  });

  it('sends a single image on the first call (no baseline yet)', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    const result = await runTool(screenTool, ctx, {}, testSignal);

    expect(secondImageArg(ctx)).toBeUndefined();
    expect(result).not.toContain('_[diff:');
  });

  it('sends screen + difference when the frames are identical (ratio 1.0)', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    await runTool(screenTool, ctx, {}, testSignal);
    const result = await runTool(screenTool, ctx, {}, testSignal);

    const second = secondImageArg(ctx);
    expect(second).toBeTruthy();
    // A valid PNG, not an arbitrary payload.
    expect(Buffer.from(second!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(result).toContain('_[diff: 100.0% identical');
  });

  it('sends the difference at 0.99922 identical (just above the threshold)', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    await runTool(screenTool, ctx, {}, testSignal);
    captureState.nextCapture = fixture('low');
    const result = await runTool(screenTool, ctx, {}, testSignal);

    expect(secondImageArg(ctx)).toBeTruthy();
    expect(result).toContain('_[diff: 99.9% identical');
  });

  it('sends the difference at 0.80 identical (well above the threshold)', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    await runTool(screenTool, ctx, {}, testSignal);
    captureState.nextCapture = fixture('high');
    const result = await runTool(screenTool, ctx, {}, testSignal);

    expect(secondImageArg(ctx)).toBeTruthy();
    expect(result).toContain('_[diff: 80.0% identical');
  });

  it('sends a single image when fewer than 15% of pixels are identical', async () => {
    // Built inline: a frame that differs in 90% of its pixels.
    const width = 64;
    const height = 64;
    const pixels = Buffer.alloc(width * height * 3, 0x20);
    const mostlyDifferent = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const differing = Buffer.from(pixels);
    for (let i = 0; i < differing.length; i++) differing[i] = 0xE0;
    const changed = await sharp(differing, { raw: { width, height, channels: 3 } }).png().toBuffer();

    captureState.nextCapture = path.join(tempDir, 'identical.png');
    fs.writeFileSync(captureState.nextCapture, mostlyDifferent);

    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    await runTool(screenTool, ctx, {}, testSignal);
    captureState.nextCapture = path.join(tempDir, 'changed.png');
    fs.writeFileSync(captureState.nextCapture, changed);
    const result = await runTool(screenTool, ctx, {}, testSignal);

    expect(secondImageArg(ctx)).toBeUndefined();
    expect(result).not.toContain('_[diff:');
  });

  it('sends a single image when the baseline belongs to another monitor', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');

    await runTool(screenTool, ctx, {}, testSignal);
    await runTool(screenTool, ctx, { desktop: 2 }, testSignal);

    expect(secondImageArg(ctx)).toBeUndefined();
  });

  it('keeps the previous baseline when the describe call fails, so the retry still diffs', async () => {
    const ctx = createMockContext(tempDir);
    vi.mocked(ctx.core.imgDescribe).mockResolvedValue('screen content');
    await runTool(screenTool, ctx, {}, testSignal); // commits baseline #1

    // Call 2 captures a DIFFERENT frame but the vision call fails.
    captureState.nextCapture = fixture('high');
    vi.mocked(ctx.core.imgDescribe).mockRejectedValueOnce(new Error('vision down'));
    const failed = await runTool(screenTool, ctx, {}, testSignal);
    expect(failed).toContain('❌');
    expect(secondImageArg(ctx)).toBeTruthy(); // call 2 did try to diff vs #1

    // Call 3 must still diff against baseline #1 (identical frame → ratio 1.0),
    // proving the failed call did not consume the committed baseline.
    captureState.nextCapture = fixture('identical');
    const retried = await runTool(screenTool, ctx, {}, testSignal);
    expect(retried).toContain('_[diff: 100.0% identical');
  });
});
