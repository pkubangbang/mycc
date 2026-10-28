/**
 * teammate-brief-level.test.ts - a teammate's `warn` brief must stay `warn`
 * when it crosses the child→parent IPC boundary.
 *
 * The wire collapses info and warn into one `type: 'log'` notification, so the
 * severity travels in a separate `level` field and the parent re-briefs with
 * that level instead of hard-coding 'info'. An error brief is carried by
 * `type: 'error'` and never reaches the log branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

vi.mock('../../loop/agent-io.js', () => ({
  agentIO: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), brief: vi.fn() },
}));
// The child side sends through this module; spying on the `ipc` singleton
// would fail because its methods are bound instance fields, so the module is
// mocked wholesale (same shape as context/core.test.ts).
vi.mock('../../context/child/ipc-helpers.js', () => ({
  ipc: { sendRequest: vi.fn().mockResolvedValue({}), sendNotification: vi.fn() },
  sendStatus: vi.fn(),
}));
vi.mock('../../engine/chat-helpers.js', () => ({
  stopSpinner: vi.fn(),
}));
vi.mock('../../config.js', () => ({
  getSessionDir: vi.fn(() => os.tmpdir()),
  isVerbose: vi.fn(() => false),
  getOllamaModel: vi.fn(() => 'test-model'),
  getVisionModel: vi.fn(() => 'test-vision-model'),
  isVisionEnabled: vi.fn(() => false),
  getApiProvider: vi.fn(() => 'ollama'),
  getOllamaHost: vi.fn(() => 'http://127.0.0.1:11434'),
  getOllamaApiKey: vi.fn(() => undefined),
  getTokenThreshold: vi.fn(() => 50000),
  getRagProvider: vi.fn(() => 'nomic'),
  getImgCacheDir: vi.fn(() => '.mycc/imgcache'),
}));

import { ipc } from '../../context/child/ipc-helpers.js';
import { ChildCore } from '../../context/child/core.js';
import { TeamManager } from '../../context/parent/team.js';
import type { AgentContext } from '../../types.js';

function makeContext(brief: ReturnType<typeof vi.fn>): AgentContext {
  return {
    core: { brief, getWorkDir: () => os.tmpdir() },
  } as unknown as AgentContext;
}

describe('teammate brief level across the IPC boundary', () => {
  let tempDir: string;
  let sessionFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-brief-level-'));
    sessionFile = path.join(tempDir, 'session.json');
    fs.writeFileSync(sessionFile, JSON.stringify({
      id: 'test-session',
      started_at: new Date().toISOString(),
      teammates: [],
      child_triologues: [],
    }));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('child side', () => {
    it('stamps level=warn on the log notification', () => {
      const core = new ChildCore('worker-1', tempDir);
      core.brief('warn', 'loop', 'watchdog timed out');

      expect(ipc.sendNotification).toHaveBeenCalledWith('log', expect.objectContaining({
        message: 'watchdog timed out',
        tool: 'loop',
        level: 'warn',
      }));
    });

    it('stamps level=info for an info brief', () => {
      const core = new ChildCore('worker-1', tempDir);
      core.brief('info', 'loop', 'all good');

      expect(ipc.sendNotification).toHaveBeenCalledWith('log', expect.objectContaining({
        level: 'info',
      }));
    });

    it('keeps error briefs on the error notification type', () => {
      const core = new ChildCore('worker-1', tempDir);
      core.brief('error', 'loop', 'boom');

      expect(ipc.sendNotification).toHaveBeenCalledWith('error', expect.objectContaining({
        error: 'boom',
        tool: 'loop',
      }));
    });
  });

  describe('parent side', () => {
    const dispatch = (team: TeamManager, msg: Record<string, unknown>): Promise<void> =>
      (team as unknown as { handleChildMessage(s: string, m: Record<string, unknown>): Promise<void> })
        .handleChildMessage('worker-1', msg);

    it('re-briefs a warn log at warn level under the @label', async () => {
      const brief = vi.fn();
      const team = new TeamManager(makeContext(brief), sessionFile);

      await dispatch(team, { type: 'log', message: 'watchdog timed out', tool: 'loop', level: 'warn' });

      expect(brief).toHaveBeenCalledWith(
        'warn', '@worker-1/loop', 'watchdog timed out', undefined, { synthetic: undefined },
      );
    });

    it('defaults to info when the sender carries no level', async () => {
      const brief = vi.fn();
      const team = new TeamManager(makeContext(brief), sessionFile);

      await dispatch(team, { type: 'log', message: 'legacy child', tool: 'loop' });

      expect(brief).toHaveBeenCalledWith(
        'info', '@worker-1/loop', 'legacy child', undefined, { synthetic: undefined },
      );
    });

    it('re-briefs an error notification as error', async () => {
      const brief = vi.fn();
      const team = new TeamManager(makeContext(brief), sessionFile);

      await dispatch(team, { type: 'error', error: 'boom', tool: 'loop' });

      expect(brief).toHaveBeenCalledWith(
        'error', '@worker-1/loop', 'boom', undefined, { synthetic: undefined },
      );
    });
  });
});
