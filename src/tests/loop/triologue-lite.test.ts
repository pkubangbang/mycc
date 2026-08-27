/**
 * triologue-lite.test.ts
 *
 * Unit tests for TriologueLite (src/loop/triologue-lite.ts) — the
 * teammate-only simplified Triologue facade used by
 * src/context/teammate-worker.ts createPersistentTriologue().
 *
 * Coverage targets:
 *  1. The 12-method public surface teammates actually use (system prompt,
 *     populators, user/note/agent/tool, getLastRole, getMessages(Raw),
 *     needsCompact, compact).
 *  2. JSONL persistence contract via onMessage — restoration.ts reads
 *     teammate transcripts with readTriologue() (whitelisted fields) +
 *     fixOrphanedToolCalls(), so the written format must stay compatible.
 *  3. TP auto-fix: tool() after a non-assistant role must inject a synthetic
 *     assistant bridge and resolve pending ids (same wiring as full facade).
 *  4. compact() swaps the store, recomputes tokens, and rebuilds project
 *     context at the boundary.
 *  5. Lead-only features are ABSENT: no wrap-up / checkpoint / hint-round /
 *     loadRestoration / clear methods on the lite class.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ToolCall } from '../../types.js';

// agentIO is imported eagerly by sibling triologue modules (e.g. compact deps);
// stub it so no real IO singletons initialize in tests. Also stub config so
// compact()'s saveTranscript can resolve a session dir without a live session.
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    brief: vi.fn(),
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../config.js', async () => {
  const os = await import('os');
  const path = await import('path');
  const tmpBase = path.join(os.tmpdir(), 'mycc-lite-test');
  return {
    getTokenThreshold: () => 50000,
    isVerbose: () => false,
    getOllamaModel: () => 'test-model',
    getOllamaHost: () => 'http://localhost:11434',
    getOllamaApiKey: () => undefined,
    getDeepSeekHost: () => 'https://api.deepseek.com',
    getDeepSeekApiKey: () => undefined,
    getDeepSeekModel: () => 'deepseek-chat',
    isVisionEnabled: () => false,
    getVisionModel: () => '',
    getSessionArg: () => null,
    shouldSkipHealthCheck: () => true,
    shouldRunSetup: () => false,
    isDebuggingEval: () => false,
    isDebuggingPrompt: () => false,
    isDebuggingTp: () => false,
    getApiProvider: () => 'ollama',
    getMyccDir: () => tmpBase,
    getLongtextDir: () => path.join(tmpBase, 'longtext'),
    ensureDirs: () => {},
    getSkillMatchThreshold: () => 0.5,
    validateEnv: () => ({ ok: true }),
    MYCC_DIR: '.mycc',
    setSessionContext: () => {},
    getSessionContext: () => 'test-session',
    getSessionDir: (id: string) => path.join(tmpBase, 'sessions', id),
    getSessionsDir: () => path.join(tmpBase, 'sessions'),
    getToolsDir: () => path.join(tmpBase, 'tools'),
    getSkillsDir: () => path.join(tmpBase, 'skills'),
    getUserToolsDir: () => path.join(tmpBase, 'user-tools'),
    getUserSkillsDir: () => path.join(tmpBase, 'user-skills'),
    getWikiDir: () => path.join(tmpBase, 'wiki'),
    getWikiLogsDir: () => path.join(tmpBase, 'wiki/logs'),
    getWikiDbDir: () => path.join(tmpBase, 'wiki/db'),
    getWikiDomainsFile: () => path.join(tmpBase, 'wiki/domains.json'),
    getRagProvider: () => 'nomic',
  };
});

// ollama.ts is selected at module load by chat-provider; compact()'s
// forkChat path resolves to it. Stub so compact's optional forkChat makes
// no real HTTP call (we pass no tools, so summary-only path is used, but
// stub defensively anyway).
vi.mock('../../engine/ollama.js', () => ({
  retryChat: vi.fn().mockResolvedValue({ message: { content: 'summary' } }),
  retryMultipleChoice: vi.fn(),
  webSearch: vi.fn(),
  webFetch: vi.fn(),
  imgDescribe: vi.fn(),
  readPictureCached: vi.fn(),
  structuredChat: vi.fn(),
  healthCheck: vi.fn(),
  getEmbedding: vi.fn(),
  MODEL: 'test-model',
}));

import { TriologueLite } from '../../loop/triologue-lite.js';

describe('TriologueLite', () => {
  let t: TriologueLite;
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = vi.fn();
    t = new TriologueLite({ tokenThreshold: 1000, onMessage });
  });

  describe('message producers', () => {
    it('user() appends a user message and fires onMessage', () => {
      t.user('hello');
      expect(t.getMessagesRaw()).toHaveLength(1);
      expect(t.getMessagesRaw()[0].role).toBe('user');
      expect(t.getMessagesRaw()[0].content).toBe('hello');
      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    it('user() combines into the last user message when lastRole is user', () => {
      t.user('first');
      t.user('second');
      const raw = t.getMessagesRaw();
      expect(raw).toHaveLength(1);
      expect(raw[0].content).toBe('first\nsecond');
    });

    it('note() prepends the [CATEGORY] prefix', () => {
      t.note('SYSTEM', 'plan mode active');
      const raw = t.getMessagesRaw();
      expect(raw[0].role).toBe('user');
      expect(raw[0].content).toBe('[SYSTEM] plan mode active');
    });

    it('note() combines with last user message (no hookName)', () => {
      t.user('task');
      t.note('REMINDER', 'update todos');
      const raw = t.getMessagesRaw();
      expect(raw).toHaveLength(1);
      expect(raw[0].content).toBe('task\n[REMINDER] update todos');
    });

    it('note() keeps hook-originated notes as separate messages', () => {
      t.user('task');
      t.note('REMINDER', 'hook fired', 'my-hook');
      const raw = t.getMessagesRaw();
      expect(raw).toHaveLength(2);
      expect(raw[1].hook_name).toBe('my-hook');
    });

    it('agent() appends assistant content and reasoning', () => {
      t.user('q');
      t.agent('thinking out loud', undefined, 'rationale');
      const raw = t.getMessagesRaw();
      expect(raw[1].role).toBe('assistant');
      expect(raw[1].content).toBe('thinking out loud');
      expect(raw[1].reasoning_content).toBe('rationale');
    });

    it('agent() with toolCalls registers pending calls; tool() resolves them', () => {
      const tcs: ToolCall[] = [
        { id: 'c1', function: { name: 'bash', arguments: { command: 'ls' } } },
        { id: 'c2', function: { name: 'read_file', arguments: { path: 'a' } } },
      ] as unknown as ToolCall[];
      t.user('go');
      t.agent('', tcs);
      t.tool('bash', 'out1', 'c1');
      t.tool('read_file', 'out2', 'c2');
      const raw = t.getMessagesRaw();
      const toolMsgs = raw.filter((m) => m.role === 'tool');
      expect(toolMsgs).toHaveLength(2);
      expect(toolMsgs[0].tool_name).toBe('bash');
      expect(toolMsgs[0].tool_call_id).toBe('c1');
      expect(toolMsgs[1].tool_call_id).toBe('c2');
    });

    it('tool() resolves ids by function name when id omitted', () => {
      const tcs: ToolCall[] = [
        { id: 'x1', function: { name: 'grep', arguments: {} } },
      ] as unknown as ToolCall[];
      t.user('go');
      t.agent('', tcs);
      t.tool('grep', 'matches');
      const toolMsg = t.getMessagesRaw().find((m) => m.role === 'tool');
      expect(toolMsg?.tool_call_id).toBe('x1');
    });
  });

  describe('TP auto-fix (tool after non-assistant role)', () => {
    it('injects a synthetic assistant bridge when tool() follows user role', () => {
      // No agent() before tool() — tool_no_assistant gap. The tpFix layer
      // injects a synthetic assistant with tool_calls, then updateLastName
      // fixes the pending name so alignment resolves cleanly.
      t.user('go');
      t.tool('bash', 'out', 'sync-1');
      const raw = t.getMessagesRaw();
      const roles = raw.map((m) => m.role);
      // user, (bridge assistant), tool
      expect(roles).toEqual(['user', 'assistant', 'tool']);
      const bridge = raw[1];
      expect(bridge.tool_calls).toBeDefined();
      expect(bridge.tool_calls!.length).toBe(1);
    });
  });

  describe('system prompt and populators', () => {
    it('getMessages() prepends system prompt then project context', () => {
      t.registerProjectContextPopulator(() => [
        { role: 'user', content: '## Platform' },
        { role: 'assistant', content: 'OK' },
      ]);
      t.rebuildProjectContext();
      t.setSystemPrompt('SYS');
      t.user('q');
      const all = t.getMessages();
      expect(all[0]).toEqual({ role: 'system', content: 'SYS' });
      expect(all[1].content).toBe('## Platform');
      expect(all[3].content).toBe('q');
    });

    it('rebuildProjectContext() refreshes populator output', () => {
      let version = 1;
      t.registerProjectContextPopulator(() => [
        { role: 'user', content: `ctx-v${version}` },
        { role: 'assistant', content: 'OK' },
      ]);
      t.rebuildProjectContext();
      version = 2;
      t.rebuildProjectContext();
      const all = t.getMessages();
      expect(all.filter((m) => m.content === 'ctx-v2')).toHaveLength(1);
      expect(all.filter((m) => m.content === 'ctx-v1')).toHaveLength(0);
    });

    it('registerProjectContextPopulator() disposer removes the populator', () => {
      const dispose = t.registerProjectContextPopulator(() => [
        { role: 'user', content: 'ctx' },
        { role: 'assistant', content: 'OK' },
      ]);
      dispose();
      t.rebuildProjectContext();
      t.user('q');
      const all = t.getMessages();
      expect(all.filter((m) => m.content === 'ctx')).toHaveLength(0);
    });
  });

  describe('accessors', () => {
    it('getLastRole() returns the last valid role and null when empty', () => {
      expect(t.getLastRole()).toBeNull();
      t.user('a');
      expect(t.getLastRole()).toBe('user');
      t.agent('b');
      expect(t.getLastRole()).toBe('assistant');
    });

    it('getLastUserQuery() tracks the last real user query (not notes)', () => {
      t.user('real query');
      t.note('REMINDER', 'nudge');
      expect(t.getLastUserQuery()).toBe('real query');
    });

    it('getTokenCount/TokenThreshold reflect constructor options', () => {
      expect(t.getTokenThreshold()).toBe(1000);
      t.user('some content');
      expect(t.getTokenCount()).toBeGreaterThan(0);
    });
  });

  describe('needsCompact / compact', () => {
    it('needsCompact() is false under threshold and true over it', () => {
      expect(t.needsCompact()).toBe(false);
      // 1000-char content ≈ >1000 tokens by the estimator — over threshold.
      t.user('x'.repeat(5000));
      expect(t.needsCompact()).toBe(true);
    });

    it('compact() replaces the conversation with a summary pair', async () => {
      t.user('fix the login bug');
      t.agent('done');
      // Force over threshold via a TOOL result (a tool result does NOT update
      // lastUserQuery — the summary embeds '**Previous user instruction:**',
      // and a huge user() query would be re-embedded into the post-compact
      // summary, legitimately keeping tokenCount above threshold).
      t.tool('bash', 'y'.repeat(5000), 'over-threshold-id');
      expect(t.needsCompact()).toBe(true);
      await t.compact();
      // Post-compact pair is tiny (mocked summary + small lastUserQuery).
      expect(t.needsCompact()).toBe(false);
      const raw = t.getMessagesRaw();
      expect(raw.length).toBeGreaterThanOrEqual(2);
      expect(raw[0].role).toBe('user');
    });

    it('compact() rebuilds project context at the boundary', async () => {
      let version = 1;
      t.registerProjectContextPopulator(() => [
        { role: 'user', content: `env-v${version}` },
        { role: 'assistant', content: 'OK' },
      ]);
      t.rebuildProjectContext();
      version = 2;
      t.user('task');
      await t.compact();
      const all = t.getMessages();
      expect(all.filter((m) => m.content === 'env-v2').length).toBe(1);
      expect(all.filter((m) => m.content === 'env-v1').length).toBe(0);
    });
  });

  describe('JSONL persistence contract (restoration.ts compatibility)', () => {
    it('onMessage receives whitelisted Message fields serializable to JSONL', () => {
      const tcs: ToolCall[] = [
        { id: 'p1', function: { name: 'bash', arguments: { command: 'ls' } } },
      ] as unknown as ToolCall[];
      t.user('go');
      t.agent('', tcs, 'why');
      t.tool('bash', 'out', 'p1');
      t.note('MAIL', 'hello');

      // Every onMessage call gets the full raw array; the last call is the
      // final state. Simulate the worker's JSONL append: last message per call.
      const lastPerCall = onMessage.mock.calls.map(
        (args: unknown[]) => (args[0] as Message[]).slice(-1)[0],
      );
      for (const m of lastPerCall) {
        const json = JSON.stringify(m);
        const parsed = JSON.parse(json) as Record<string, unknown>;
        // restoration.ts readTriologue whitelists these fields:
        expect(['user', 'assistant', 'tool']).toContain(parsed.role);
        expect(typeof parsed.content).toBe('string');
        if (parsed.tool_name !== undefined) expect(typeof parsed.tool_name).toBe('string');
        if (parsed.tool_call_id !== undefined) expect(typeof parsed.tool_call_id).toBe('string');
        if (parsed.reasoning_content !== undefined) expect(typeof parsed.reasoning_content).toBe('string');
      }
      // The tool message must carry tool_name + tool_call_id for orphan fixing.
      const toolMsg = lastPerCall.find((m) => m.role === 'tool');
      expect(toolMsg?.tool_name).toBe('bash');
      expect(toolMsg?.tool_call_id).toBe('p1');
    });

    it('assistant tool_calls survive a JSONL round-trip shape check', () => {
      const tcs: ToolCall[] = [
        { id: 'q9', function: { name: 'edit_file', arguments: { path: 'x' } } },
      ] as unknown as ToolCall[];
      t.user('go');
      t.agent('doing', tcs);
      const assistantMsg = onMessage.mock.calls.map(
        (args: unknown[]) => (args[0] as Message[]).slice(-1)[0],
      ).find((m) => m.role === 'assistant');
      const roundTrip = JSON.parse(JSON.stringify(assistantMsg)) as Message;
      expect(roundTrip.tool_calls).toHaveLength(1);
      expect(roundTrip.tool_calls![0].id).toBe('q9');
      expect(roundTrip.tool_calls![0].function.name).toBe('edit_file');
    });
  });

  describe('lead-only features are absent', () => {
    it('does not expose wrap-up / checkpoint / hint-round / restoration / clear', () => {
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(t));
      for (const absent of [
        'beginWrapUp', 'finishWrapUp', 'commitWrapUp', 'rollbackWrapUp',
        'hasActiveWrapUp', 'getCheckpointManager', 'generateHintRound',
        'loadRestoration', 'clear', 'skipPendingTools',
      ]) {
        expect(proto).not.toContain(absent);
      }
    });
  });
});