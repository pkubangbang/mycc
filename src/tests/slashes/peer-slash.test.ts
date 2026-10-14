/**
 * peer-slash.test.ts - Tests for the /peer SLASH command rendering.
 *
 * The command prints a FLAT block per peer (full session id at column 0,
 * then `dir`/`started`/`brief` detail lines), plus an optional durable
 * compose NAME (`<group>:<peer>`) right after the id. These tests pin:
 *   - the FULL session id is printed (never truncated — it is the mail_to
 *     address and must be copy-pasteable);
 *   - the optional compose `name` is surfaced when present, absent otherwise;
 *   - the detail labels render with the 8-char gutter;
 *   - the 1h cutoff still omits long-dead peers.
 *
 * The render helpers are internal to the module, so we drive the exported
 * command handler with a mock context and capture console.log output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { peerCommand } from '../../slashes/peer.js';
import { createMockContext as createFullMockContext } from '../test-utils/mock-context.js';
import type { AgentContext, IdentityEntry, SlashCommandContext } from '../../types.js';

const SID = '6df5fa5f-53b2-4c8c-ad23-872b193c2f97';

function mkIdentity(over: Partial<IdentityEntry> = {}): IdentityEntry {
  return {
    sessionId: SID,
    workDir: 'C:\\Proj\\mycc',
    mailbox: '/mb/x/unread-lead.jsonl',
    startedAt: Date.now() - 60_000,
    ...over,
  };
}

/** Drive the command, capturing everything it prints to stdout. */
function run(args: string[], ctx: AgentContext): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(' '));
  });
  try {
    const slashCtx = {
      query: `/peer ${args.join(' ')}`.trim(),
      args,
      ctx,
      triologue: undefined,
      sessionFilePath: '',
    } as unknown as SlashCommandContext;
    peerCommand.handler(slashCtx);
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

describe('/peer slash command', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    ctx = createFullMockContext();
    (ctx.peer.getSelfSessionId as ReturnType<typeof vi.fn>).mockReturnValue('self-0000-0000-0000-000000000000');
    (ctx.peer.getLatestHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue(Date.now() - 1000);
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (ctx.peer.getBriefs as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (ctx.peer.getPid as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the FULL session id (never truncated) so it can be pasted into mail_to', () => {
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue([mkIdentity()]);

    const out = run(['/peer'], ctx);

    expect(out).toContain(SID); // full 36-char UUID present verbatim
    expect(out).not.toContain('6df5…2f97'); // no ellipsis-collapsed form
  });

  it('surfaces the optional compose NAME when present (stable handle)', () => {
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue([
      mkIdentity({ name: 'demo:worker-1' }),
    ]);

    const out = run(['/peer'], ctx);

    expect(out).toContain('demo:worker-1');
  });

  it('omits the name entirely for a non-compose peer', () => {
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue([mkIdentity()]);

    const out = run(['/peer'], ctx);

    expect(out).toContain(SID);
    // No stray name token / label leaked in.
    expect(out).not.toMatch(/demo:/);
  });

  it('renders the flat detail labels (dir / started) with the 2-space indent', () => {
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue([mkIdentity()]);

    const out = run(['/peer'], ctx);

    expect(out).toMatch(/^ {2}dir {5}C:/m);
    expect(out).toMatch(/^ {2}started /m);
  });

  it('marks online/offline and counts them in the header', () => {
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue([
      mkIdentity({ sessionId: 'aaaa0000-0000-0000-0000-000000000001' }),
      mkIdentity({ sessionId: 'bbbb0000-0000-0000-0000-000000000002' }),
    ]);
    (ctx.peer.isFresh as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const out = run(['/peer', '--all'], ctx);

    expect(out).toContain('1 online');
    expect(out).toContain('● online');
    expect(out).toContain('○ offline');
  });

  it('still applies the 1h cutoff (a long-dead peer is omitted and counted)', () => {
    const HOUR = 60 * 60 * 1000;
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue([
      mkIdentity({ sessionId: 'dead0000-0000-0000-0000-000000000003' }),
    ]);
    (ctx.peer.getLatestHeartbeat as ReturnType<typeof vi.fn>).mockReturnValue(Date.now() - 2 * HOUR);

    const out = run(['/peer', '--all'], ctx);

    expect(out).toContain('older than 1h');
    expect(out).not.toContain('dead0000-0000-0000-0000-000000000003');
  });

  it('clamps a long brief to a single line', () => {
    const long = 'x'.repeat(500);
    (ctx.peer.listIdentities as ReturnType<typeof vi.fn>).mockReturnValue([mkIdentity()]);
    (ctx.peer.getBriefs as ReturnType<typeof vi.fn>).mockReturnValue([
      { time: Date.now(), content: long, confidence: 8 },
    ]);

    const out = run(['/peer'], ctx);

    const briefLine = out.split('\n').find((l) => l.includes('brief ')) ?? '';
    expect(briefLine).toContain('…');
    expect(briefLine.length).toBeLessThan(200);
  });
});
