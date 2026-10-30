/**
 * plan-mode-escalation.test.ts — plan mode must not decide command safety by
 * substring-matching the command line.
 *
 * THE DEFECT THESE TESTS PIN (regression, observed in a live session):
 *
 * `planModeCommandViolation` used to BLOCK on a shape match. The rules match
 * the WHOLE command line, so a glob or a write verb appearing anywhere — even
 * inside a quoted grep pattern or an echoed section label — read as a real
 * mutation:
 *
 *   grep -rn "triologue\.\([a-zA-Z_]*\)" src --include=*.ts
 *     → "Batch deletion is not allowed in plan mode"
 *   cat a.ts && echo "=== truncate" && cat b.ts
 *     → "The command modifies state"
 *   node -e '... console.log("rm -rf dist/") ...'
 *     → "Batch deletion is not allowed in plan mode"
 *
 * THE RULE NOW: a shape match means "no local rule can classify this", so it
 * ESCALATES to the same LLM judge the RUN verb already uses. Only the
 * dangerous-command list is hard-blocked. A judge failure / ESC / unknown
 * answer falls through to the human (fail closed).
 *
 * DIRECTION MATTERS BOTH WAYS: the last two describes prove the change did not
 * merely loosen the gate — a real mutation declared READ, and the dangerous
 * list, are still blocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../engine/chat-provider.js', () => ({
  // The plan-mode LLM judge. Each test overrides the resolved value; the
  // default ('READ') is the "positively read-only" verdict.
  retryMultipleChoice: vi.fn().mockResolvedValue('READ'),
  MODEL: 'test-model',
}));

import { retryMultipleChoice } from '../../../engine/chat-provider.js';
import { judgeBash } from '../../../context/grant/bash-judge.js';

const judge = vi.mocked(retryMultipleChoice);

/** Intent for a read-only survey command. */
const READ_INTENT = 'READ SOURCE dir=src TO survey the triologue facade';

function askUser(answer: string | null) {
  return vi.fn(async () => answer as unknown as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  judge.mockResolvedValue('READ');
});

describe('plan mode — shape matches escalate instead of blocking', () => {
  // Verbatim from the session that exposed the bug.
  const FALSE_BLOCKS: Array<[string, string]> = [
    [
      'grep pipeline with a quoted regex and a glob include',
      'cd /home/student/proj/mycc && grep -rn "triologue\\.\\([a-zA-Z_]*\\)" src --include=*.ts -o | sed \'s/.*triologue\\.\\///\' | sort | uniq -c',
    ],
    [
      'cat chain whose label mentions a write verb',
      'cd /home/student/proj/mycc && cat src/loop/triologue/types.ts && echo "=== truncate" && cat src/loop/triologue/truncate.ts',
    ],
    [
      'node -e whose string literal contains a deletion',
      'node -e \'const c = "rm -rf dist/ node_modules/"; console.log(c.length)\'',
    ],
  ];

  for (const [name, command] of FALSE_BLOCKS) {
    it(`allows when the judge says READ: ${name}`, async () => {
      const ask = askUser('n');
      const res = await judgeBash(command, READ_INTENT, 'plan', false, ask);

      // The judge was consulted (this is the escalation), and it allowed.
      expect(judge).toHaveBeenCalledTimes(1);
      expect(res.decision).toBe('allow');
      // The user was not bothered: a positive READ verdict is decisive.
      expect(ask).not.toHaveBeenCalled();
    });
  }

  it('blocks when the judge says WRITE, with the judge\'s own reason', async () => {
    judge.mockResolvedValue('WRITE');
    const res = await judgeBash(
      'grep -rn "x" src --include=*.ts',
      READ_INTENT,
      'plan',
      false,
      askUser('y'),
    );
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('LLM determined');
  });

  it('fails closed on an LLM error: asks the user, naming the cause', async () => {
    judge.mockRejectedValue(new Error('provider down'));
    const ask = askUser('n');
    const res = await judgeBash(
      'cat a.ts && echo "=== truncate" && cat b.ts',
      READ_INTENT,
      'plan',
      false,
      ask,
    );
    expect(res.decision).toBe('block');
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining('could not be reached'),
      'bash-judge',
      { onEsc: 'n' },
    );
  });

  it('asks the user with the escalation wording when the judge is uncertain', async () => {
    judge.mockResolvedValue('UNCERTAIN');
    const ask = askUser('y');
    const res = await judgeBash(
      'ls --include=*.ts',
      READ_INTENT,
      'plan',
      false,
      ask,
    );
    expect(res.decision).toBe('allow'); // the human approved
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining('escalated for a safety check'),
      'bash-judge',
      { onEsc: 'n' },
    );
  });

  it('denies when the escalation prompt goes unanswered', async () => {
    judge.mockResolvedValue('UNCERTAIN');
    const res = await judgeBash('ls *.ts', READ_INTENT, 'plan', false, askUser(''));
    expect(res.decision).toBe('block');
  });

  it('child process: distinct message, and no LLM call', async () => {
    const res = await judgeBash(
      'grep -rn "x" src --include=*.ts',
      READ_INTENT,
      'plan',
      true,
      askUser('y'),
    );
    expect(res.decision).toBe('block');
    // Regression: a child was told to "use a specific verb instead of RUN"
    // although its verb WAS specific.
    expect(res.reason).not.toContain('instead of RUN');
    expect(res.reason).toContain('child process');
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('plan mode — no shape match means no judgement call', () => {
  // These are NOT regressions and NOT escalations: no rule fires, so the
  // command is allowed by the cheap path. They are here so the boundary is
  // pinned — the gate escalates only on a shape hit, never speculatively.
  //
  // NOTE: `echo "use: cat a > b"` is NOT in this list on purpose. The redirect
  // rule sees the `"> b"` and treats the command as complex; the LLM judge then
  // refines it. That is the intended trade (one LLM call on a rare shape) — a
  // quote-aware redirect rule would be the parser this design rejects.
  it.each([
    ['grep for a write verb string in docs', 'grep -rn git changelog-todo.md'],
    ['grep for a delete word without a glob', 'grep -n delete src/util/str.ts'],
  ])('allows without the judge: %s', async (_name, command) => {
    const res = await judgeBash(command, READ_INTENT, 'plan', false, askUser('n'));
    expect(res.decision).toBe('allow');
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('plan mode — the cheap path stays cheap', () => {
  it.each([
    ['cat file.ts', 'plain cat'],
    ['ls -la src', 'plain ls'],
    ['git diff HEAD', 'git diff'],
    ['npm run build', 'npm script'],
  ])('does not call the judge for a trivially shaped command (%s)', async (command, _name) => {
    const res = await judgeBash(command, READ_INTENT, 'plan', false, askUser('n'));
    expect(res.decision).toBe('allow');
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('plan mode — real mutations are still refused', () => {
  it('hard-blocks the dangerous list without consulting the judge', async () => {
    // Step 1's dangerous check runs BEFORE plan mode is even considered, so it
    // answers with its own (pre-existing) Socratic wording — the point under
    // test is that it never reaches planModeHardBlock's escalation or the LLM.
    const res = await judgeBash(
      'mkfs.ext4 /dev/sda1',
      'READ SOURCE dir=src TO inspect the disk',
      'plan',
      false,
      askUser('y'),
    );
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('Command blocked');
    // Unrecoverable operations are never delegated to a judgement call.
    expect(judge).not.toHaveBeenCalled();
  });

  it('blocks a real mutation that the judge reports as WRITE', async () => {
    // `rm -rf src/` declared READ never reaches a local allow: its shape
    // escalates, and it is the judge that refuses it.
    judge.mockResolvedValue('WRITE');
    const res = await judgeBash(
      'cd build && rm -rf dist/ node_modules/',
      READ_INTENT,
      'plan',
      false,
      askUser('y'),
    );
    expect(judge).toHaveBeenCalledTimes(1);
    expect(res.decision).toBe('block');
  });

  it('still blocks mutation verbs outright, before any command-shape question', async () => {
    const res = await judgeBash('rm -rf src/', 'DELETE SOURCE dir=src TO clean', 'plan', false, askUser('y'));
    expect(res.decision).toBe('block');
    expect(res.reason).toContain('Cannot DELETE in plan mode');
    expect(judge).not.toHaveBeenCalled();
  });
});
