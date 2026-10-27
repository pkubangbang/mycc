/**
 * recap-rewind-empty-summary.test.ts — H2 at the SOURCE: an empty fork result
 * must survive as empty.
 *
 * Before the fix, `handleRecap` ended with `summary = summary || '(no summary)'`,
 * so a provider hiccup / truncated stream / refusal that produced '' turned into
 * a non-empty note, passed every size check, and let the caller truncate the
 * span — deleting the conversation AND replacing it with a placeholder. The
 * summary floor in states/hook.ts can only refuse an empty summary if this
 * function actually returns one, so this is the test that pins the producer.
 *
 * (An earlier version of this file drove the floor through handleHook; the
 * end-to-end dispatch is already covered by hook-esc-recap.test.ts, and the
 * fork here is mocked at the provider boundary, which is where the emptiness
 * originates.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../engine/chat-provider.js', () => ({
  forkChat: vi.fn(async () => ''),
}));
vi.mock('../../../loop/agent-io.js', () => ({
  agentIO: { verbose: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn(), brief: vi.fn() },
}));

import { forkChat } from '../../../engine/chat-provider.js';
import { handleRecap } from '../../../loop/recap-rewind.js';
import type { Message, Tool } from '../../../types.js';

const messages: Message[] = [{ role: 'user', content: 'do the work' }];
const span: Message[] = [{ role: 'user', content: 'do the work' }];
const tools: Tool[] = [];

/** Run handleRecap with a given fork result (the lead's ESC-aware path). */
async function recap(forkResult: string, escAware = true): Promise<string> {
  vi.mocked(forkChat).mockResolvedValue(forkResult);
  const wrapper = escAware
    ? async <T>(fn: (ac: AbortController) => Promise<T>): Promise<T> => fn(new AbortController())
    : undefined;
  return handleRecap(messages, span, tools, 'explored the parser', wrapper, 'Next: fix it');
}

describe('handleRecap — empty summary is not substituted (H2 producer)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('an empty fork result stays empty', async () => {
    const out = await recap('');
    // BEFORE: '(no summary)' → the caller's floor saw a "valid" note and the
    // span was truncated. AFTER: the caller's floor refuses, nothing truncated.
    expect(out).not.toContain('(no summary)');
    // The fixed header is still there (it frames the note); what must be absent
    // is any CONTENT line — the summary body is empty.
    expect(out).toContain('Some actions have been performed before this recap');
    const afterHeader = out.split('Here is the summary:')[1] ?? '';
    const contentLines = afterHeader
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('**'));
    expect(contentLines).toEqual([]);
  });

  it('a whitespace-only fork result leaves no summary body', async () => {
    const out = await recap('   \n\t ');
    const bodyLine = out.split('\n').find((l) => l.trim().length > 0 && !l.startsWith('**'));
    // Only the fixed header line remains — no content line was contributed.
    expect(bodyLine).toBe('Some actions have been performed before this recap but the details have been omitted. Here is the summary:');
  });

  it('the raw value is trimmed, not padded', async () => {
    const out = await recap('   real summary text   ', false);
    expect(out).toContain('real summary text');
    expect(out.includes('   real summary text   ')).toBe(false);
  });

  it('ESC still returns the cancelled sentinel, not an empty note', async () => {
    const escAware = async <T>(): Promise<T> => null as T;
    vi.mocked(forkChat).mockResolvedValue('ignored');
    const out = await handleRecap(messages, span, tools, 'd', escAware, 'c');
    expect(out.startsWith('[RECAP] Cancelled:')).toBe(true);
  });

  it('empty history short-circuits before forking', async () => {
    const out = await handleRecap([], span, tools, 'd', undefined, 'c');
    expect(out).toBe('[RECAP] No messages to summarize.');
    expect(forkChat).not.toHaveBeenCalled();
  });
});
