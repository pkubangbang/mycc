/**
 * core.test.ts - Tests for the mode and grant system
 *
 * Tests the mode system (plan/normal) and requestGrant functionality
 * for both parent and child contexts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Core } from '../../context/parent/core.js';
import { isWebUiUp, setWebUiUp } from '../../loop/loop-events.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Mock agentIO for parent Core
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    ask: vi.fn(),
  },
}));

// Mock ollama for web search/fetch
vi.mock('../../engine/ollama.js', () => ({
  ollama: {
    webSearch: vi.fn(),
    webFetch: vi.fn(),
    chat: vi.fn(),
  },
  MODEL: 'test-model',
  retryChat: vi.fn(),
  retryMultipleChoice: vi.fn(),
  webSearch: vi.fn().mockResolvedValue([]),
  webFetch: vi.fn(),
  imgDescribe: vi.fn(),
  structuredChat: vi.fn(),
  healthCheck: vi.fn(),
}));
vi.mock('../../engine/chat-helpers.js', () => ({
  retryWithBackoff: vi.fn(async (fn: any) => fn()),
}));

// Mock config
vi.mock('../../config.js', () => ({
  isVerbose: vi.fn(() => false),
  getVisionModel: vi.fn(() => 'test-vision-model'),
  isVisionEnabled: vi.fn(() => false),
  getApiProvider: vi.fn(() => 'ollama'),
  getOllamaHost: vi.fn(() => 'http://127.0.0.1:11434'),
  getOllamaApiKey: vi.fn(() => undefined),
  getOllamaModel: vi.fn(() => 'test-model'),
  getTokenThreshold: vi.fn(() => 50000),
  getRagProvider: vi.fn(() => 'nomic'),
  getImgCacheDir: vi.fn(() => '.mycc/imgcache'),
  getLongtextDir: vi.fn(() => '.mycc/longtext'),
  getPlanModeWritableDirs: vi.fn(() => ['.mycc/longtext', '.mycc/imgcache']),
}));

// Mock ipc-helpers for ChildCore tests - use factory that returns mock functions
vi.mock('../../context/child/ipc-helpers.js', () => ({
  ipc: {
    sendRequest: vi.fn().mockResolvedValue({ approved: true }),
    sendNotification: vi.fn(),
  },
  sendStatus: vi.fn(),
}));

// Import ChildCore AFTER mocking ipc-helpers
import { ChildCore } from '../../context/child/core.js';
import { ipc } from '../../context/child/ipc-helpers.js';

// ============================================================================
// Parent Core Tests - Mode System
// ============================================================================

describe('Core (Parent) - Mode System', () => {
  let core: Core;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-core-test-'));
    core = new Core(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('Mode State', () => {
    it('should start in normal mode by default', () => {
      expect(core.getMode()).toBe('normal');
    });

    it('should change mode to plan', () => {
      core.setMode('plan');
      expect(core.getMode()).toBe('plan');
    });

    it('should change mode back to normal', () => {
      core.setMode('plan');
      core.setMode('normal');
      expect(core.getMode()).toBe('normal');
    });
  });

  describe('Serve State (loop-events holder)', () => {
    // The serve layer owns a single process-wide boolean in
    // src/loop/loop-events.ts (setWebUiUp/isWebUiUp). Core no longer keeps a
    // copy: readers ask the holder directly, so there is nothing on Core to
    // round-trip through a signal. These tests pin the holder's semantics that
    // replace the retired `serve_state` event.
    it('should start with the WebUI reported down', () => {
      expect(isWebUiUp()).toBe(false);
    });

    it('should flip true on setWebUiUp(true), false on setWebUiUp(false)', () => {
      setWebUiUp(true);
      expect(isWebUiUp()).toBe(true);
      setWebUiUp(false);
      expect(isWebUiUp()).toBe(false);
    });

    it('should stay true across a restart (a recycle is not a stop)', () => {
      // restartServe() calls stop(true) → start() internally, re-setting the
      // flag to true at the end; the loop must never observe a "down" blip.
      setWebUiUp(true);
      setWebUiUp(false); // stop() inside restartServe
      setWebUiUp(true);  // restartServe() re-set on the same port
      expect(isWebUiUp()).toBe(true);
    });
  });

  describe('requestGrant in normal mode', () => {
    it('should approve grants in normal mode', async () => {
      // Ensure we're in normal mode
      core.setMode('normal');

      const result = await core.requestGrant('write_file', { path: '/test/file.ts' });

      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should approve edit_file grants in normal mode', async () => {
      core.setMode('normal');

      const result = await core.requestGrant('edit_file', { path: '/test/file.ts' });

      expect(result.approved).toBe(true);
    });

    it('should approve bash grants in normal mode', async () => {
      core.setMode('normal');

      const result = await core.requestGrant('bash', { command: 'echo test', intent: 'READ SOURCE TO test output' });

      expect(result.approved).toBe(true);
    });
  });

  describe('requestGrant in plan mode', () => {
    it('should reject all grants in plan mode', async () => {
      core.setMode('plan');

      const result = await core.requestGrant('write_file', { path: '/test/file.ts' });

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('plan mode');
    });

    it('should reject edit_file grants in plan mode', async () => {
      core.setMode('plan');

      const result = await core.requestGrant('edit_file', { path: '/test/file.ts' });

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('plan mode');
    });

    it('should reject bash grants in plan mode', async () => {
      core.setMode('plan');

      const result = await core.requestGrant('bash', { command: 'echo test', intent: 'READ SOURCE TO test output' });

      expect(result.approved).toBe(true); // READ verb is allowed in plan mode
    });

    it('should reject mutation verbs in plan mode', async () => {
      core.setMode('plan');

      const result = await core.requestGrant('bash', { command: 'npm run build', intent: 'BUILD ARTIFACT TO compile project' });

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Cannot BUILD in plan mode');
    });

    it('should reject bash without intent', async () => {
      core.setMode('plan');

      const result = await core.requestGrant('bash', { command: 'echo test' });

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('intent');
    });

    it('should allow write_file into .mycc/longtext in plan mode', async () => {
      core.setMode('plan');

      const longtextFile = path.join(tempDir, '.mycc', 'longtext', 'dump.txt');
      const result = await core.requestGrant('write_file', { path: longtextFile });

      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should allow edit_file into .mycc/imgcache in plan mode', async () => {
      core.setMode('plan');

      const imgcacheFile = path.join(tempDir, '.mycc', 'imgcache', 'abc123.json');
      const result = await core.requestGrant('edit_file', { path: imgcacheFile });

      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should still reject writes to project source in plan mode', async () => {
      core.setMode('plan');

      const srcFile = path.join(tempDir, 'src', 'index.ts');
      const result = await core.requestGrant('write_file', { path: srcFile });

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('plan mode');
    });

    it('should reject writes to .mycc/sessions (not a tool-output dir)', async () => {
      core.setMode('plan');

      const sessionFile = path.join(tempDir, '.mycc', 'sessions', 'sess-1', 'state.json');
      const result = await core.requestGrant('write_file', { path: sessionFile });

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('plan mode');
    });
  });
});

// ============================================================================
// Parent Core Tests - requestGrant Method Signature
// ============================================================================

describe('Core (Parent) - requestGrant Method', () => {
  let core: Core;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-core-test-'));
    core = new Core(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should have requestGrant method on Core', () => {
    expect(core.requestGrant).toBeDefined();
    expect(typeof core.requestGrant).toBe('function');
  });

  it('should accept write_file tool with path', async () => {
    core.setMode('normal');

    const result = await core.requestGrant('write_file', { path: '/test/file.ts' });

    expect(result).toHaveProperty('approved');
    expect(typeof result.approved).toBe('boolean');
  });

  it('should accept edit_file tool with path', async () => {
    core.setMode('normal');

    const result = await core.requestGrant('edit_file', { path: '/test/file.ts' });

    expect(result).toHaveProperty('approved');
    expect(typeof result.approved).toBe('boolean');
  });

  it('should accept bash tool with command', async () => {
    core.setMode('normal');

    const result = await core.requestGrant('bash', { command: 'ls -la' });

    expect(result).toHaveProperty('approved');
    expect(typeof result.approved).toBe('boolean');
  });

  it('should return reason when rejected', async () => {
    core.setMode('plan');

    const result = await core.requestGrant('write_file', { path: '/test/file.ts' });

    expect(result.approved).toBe(false);
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe('string');
  });
});

// ============================================================================
// Parent Core Tests - the denial ring (hint round's permission evidence)
// ============================================================================

describe('Core (Parent) - the denial ring', () => {
  let core: Core;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-core-denials-'));
    core = new Core(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('records nothing while every grant is approved', async () => {
    core.setMode('normal');

    await core.requestGrant('write_file', { path: '/test/file.ts' });
    await core.requestGrant('bash', { command: 'echo hi', intent: 'READ SOURCE TO test output' });

    expect(core.getRecentDenials()).toEqual([]);
  });

  it('records one entry per refusal, with the tool, target and derived kind', async () => {
    core.setMode('plan');

    const verdict = await core.requestGrant('write_file', { path: '/test/file.ts' });

    expect(verdict.approved).toBe(false);
    const denials = core.getRecentDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      tool: 'write_file',
      target: '/test/file.ts',
      // Derived from the verdict's OWN reason at record time — plan mode.
      kind: 'plan-mode',
      seq: 1,
    });
    // The recorded reason is the gate's prose, verbatim (no re-derivation).
    expect(denials[0].reason).toBe(verdict.reason);
  });

  it('classifies a bash refusal by its structural kind, keyed by the command', async () => {
    core.setMode('normal');

    // Intents must be WELL-FORMED: the grammar check precedes the danger scan
    // and the git-commit routing, so a malformed intent is refused as 'intent'
    // before the command itself is ever judged.
    // `git commit` is the `system` routing nudge (hard-blocked, no escape hatch),
    // so it is recorded as 'dangerous'; without the escape PARAM the irreversible
    // command is hard-blocked with a Socratic hint and never reaches [y/N].
    const irreversible = 'mk' + 'fs.ext4 /dev/sdb1';
    await core.requestGrant('bash', { command: irreversible, intent: 'DELETE DATA path=dev_sdb1 TO wipe the test disk' });
    await core.requestGrant('bash', { command: 'git commit -m "x"', intent: 'RUN SYSTEM TO commit changes' });
    await core.requestGrant('bash', { command: 'echo hi' }); // no intent → grammar rule

    const denials = core.getRecentDenials();
    // Both "Command blocked:" reasons classify as 'dangerous' — classifyDenial
    // keys on the word "blocked", so the git_commit routing nudge and the
    // dangerous-command block share one structural kind by design.
    expect(denials.map((d) => d.kind)).toEqual(['intent', 'dangerous', 'intent']);
    // bash targets the COMMAND, not a path.
    expect(denials[0].target).toBe(irreversible);
    expect(denials[2].target).toBe('echo hi');
  });

  it('derives the kind from the verdict REASON, not the command text', async () => {
    core.setMode('normal');
    // Guard for classifyDenial's marker precedence: the plan-mode reason is the
    // first rule in the chain, so a future reorder is caught here. plan-mode is
    // used because bash refusals of a dangerous command carry a Socratic hint
    // whose OWN text mentions "intent" — exactly the ambiguity a fixture should
    // not depend on.
    const verdict = await core.requestGrant('write_file', { path: '/test/file.ts' });

    // Approved in normal mode — nothing recorded yet.
    expect(verdict.approved).toBe(true);
    expect(core.getRecentDenials()).toEqual([]);

    core.setMode('plan');
    await core.requestGrant('write_file', { path: '/test/file.ts' });

    const [denial] = core.getRecentDenials();
    expect(denial.reason).toContain('plan mode');
    expect(denial.kind).toBe('plan-mode');
  });

  it('caps the ring at 8 entries, dropping the OLDEST first', async () => {
    core.setMode('plan');

    for (let i = 0; i < 11; i++) {
      await core.requestGrant('write_file', { path: `/test/file-${i}.ts` });
    }

    const denials = core.getRecentDenials();
    expect(denials).toHaveLength(8);
    // Newest last: file-3..file-10 survive, file-0..file-2 were shifted out.
    expect(denials[0].target).toBe('/test/file-3.ts');
    expect(denials[denials.length - 1].target).toBe('/test/file-10.ts');
    // seq stays monotonic across the shift, so recency ordering survives.
    expect(denials.map((d) => d.seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('returns a COPY — callers cannot mutate the buffer', async () => {
    core.setMode('plan');
    await core.requestGrant('write_file', { path: '/test/file.ts' });

    const snapshot = core.getRecentDenials();
    snapshot.push({ tool: 'bash', target: 'rm -rf /', reason: 'x', kind: 'dangerous', seq: 99 });
    snapshot[0].kind = 'other';

    const fresh = core.getRecentDenials();
    expect(fresh).toHaveLength(1);
    expect(fresh[0].kind).toBe('plan-mode');
  });
});

// ============================================================================
// Child Core Tests - requestGrant IPC
// ============================================================================

describe('ChildCore - requestGrant Method', () => {
  let childCore: ChildCore;
  const mockSendRequest = vi.mocked(ipc.sendRequest);

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendRequest.mockResolvedValue({ approved: true });
    childCore = new ChildCore('test-child', '/test/workdir');
  });

  it('should have requestGrant method on ChildCore', () => {
    expect(childCore.requestGrant).toBeDefined();
    expect(typeof childCore.requestGrant).toBe('function');
  });

  it('should send IPC request for write_file grant', async () => {
    // This test documents the expected behavior
    await childCore.requestGrant('write_file', { path: '/test/file.ts' });
    
    expect(mockSendRequest).toHaveBeenCalledWith(
      'grant_request',
      expect.objectContaining({ tool: 'write_file', path: '/test/file.ts' }),
      expect.any(Number)
    );
  });

  it('should send IPC request for bash grant', async () => {
    mockSendRequest.mockResolvedValue({ approved: true, reason: undefined });
    
    await childCore.requestGrant('bash', { command: 'echo test' });
    
    expect(mockSendRequest).toHaveBeenCalledWith(
      'grant_request',
      expect.objectContaining({ tool: 'bash', command: 'echo test' }),
      expect.any(Number)
    );
  });

  it('should return the IPC response', async () => {
    mockSendRequest.mockResolvedValue({ approved: false, reason: 'Plan mode' });
    
    const result = await childCore.requestGrant('write_file', { path: '/test/file.ts' });
    
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('Plan mode');
  });
});

// ============================================================================
// Grant Evaluator Tests (for parent process)
// ============================================================================

describe('Grant Evaluator', () => {
  let core: Core;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-core-grant-'));
    core = new Core(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Plan Mode', () => {
    it('should reject all grants in plan mode', async () => {
      core.setMode('plan');
      const result = await core.requestGrant('write_file', { path: path.join(tempDir, 'src', 'file.ts') });
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('plan mode');
    });
  });

  describe('Bash Command Restrictions', () => {
    it('should block dangerous commands (rm -rf /)', async () => {
      core.setMode('normal');
      const result = await core.requestGrant('bash', {
        command: 'rm -rf /',
        intent: 'DELETE DATA TO reclaim disk space',
      });
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('blocked');
    });

    it('should block git commit (must use git_commit tool)', async () => {
      core.setMode('normal');
      const result = await core.requestGrant('bash', {
        command: 'git commit -m "test"',
        intent: 'RUN SYSTEM TO commit changes',
      });
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('git_commit tool');
    });
  });
});