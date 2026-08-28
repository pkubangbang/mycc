/**
 * Tests for mycc_title tool
 *
 * The tool's main function is NOT returning 'OK' — it is writing the terminal
 * title via an ANSI OSC 0 escape sequence (process.stdout.write `\x1b]0;<title>\x07`)
 * plus a visible banner. The earlier tests only asserted `result === 'OK'`, which
 * would stay green even if the stdout side-effect (the whole point of the tool)
 * were removed. These tests spy on process.stdout.write to pin the actual
 * title-setting behavior and the normalizeTitle prefix-stripping logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { myccTitleTool } from '../../tools/mycc_title.js';

describe('myccTitleTool', () => {
  it('should have correct name and scope', () => {
    expect(myccTitleTool.name).toBe('mycc_title');
    expect(myccTitleTool.scope).toContain('main');
    expect(myccTitleTool.scope).toContain('child');
  });

  it('should require title parameter', () => {
    expect(myccTitleTool.input_schema.required).toContain('title');
  });

  it('should return error for missing title', () => {
    const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
    const result = myccTitleTool.handler(ctx, {});
    expect(result).toBe('Error: title parameter is required and must be a string');
  });

  it('should return error for non-string title', () => {
    const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
    const result = myccTitleTool.handler(ctx, { title: 123 });
    expect(result).toBe('Error: title parameter is required and must be a string');
  });

  describe('main function — emits OSC 0 title via stdout', () => {
    let writes: string[];
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let originalPlatform: NodeJS.Platform;

    beforeEach(() => {
      writes = [];
      // Spy on process.stdout.write to capture both the OSC sequence and the
      // banner. The OSC 0 line is what actually sets the terminal title.
      stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
      // Pin platform to a non-win32 value so the process.title fallback branch
      // does not run (it mutates global process state).
      originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('should return OK for a valid title', () => {
      const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
      const result = myccTitleTool.handler(ctx, { title: 'test title' });
      expect(result).toBe('OK');
    });

    it('should write the ANSI OSC 0 escape sequence with the normalized title', () => {
      const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
      myccTitleTool.handler(ctx, { title: 'fixing bash tool' });
      // The OSC 0 sequence: ESC ] 0 ; <title> BEL. The normalized title gets the
      // canonical "mycc: " prefix applied.
      const osc = writes.find(w => w.includes('\x1b]0;') && w.includes('\x07'));
      expect(osc).toBeDefined();
      expect(osc).toContain('\x1b]0;mycc: fixing bash tool\x07');
    });

    it('should also write a visible banner to stdout', () => {
      const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
      myccTitleTool.handler(ctx, { title: 'demo' });
      // The banner is multi-line: at least the OSC line + banner lines. Joining
      // all writes, the normalized title must appear in the banner text too.
      const all = writes.join('');
      expect(all).toContain('mycc: demo');
    });

    it('should NOT write the OSC sequence when the title is missing (early return)', () => {
      const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
      myccTitleTool.handler(ctx, {});
      expect(writes.some(w => w.includes('\x1b]0;'))).toBe(false);
    });

    // --- normalizeTitle prefix-stripping coverage ---

    it('normalizeTitle: strips an existing "mycc: " prefix and re-applies the canonical one', () => {
      const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
      myccTitleTool.handler(ctx, { title: 'mycc: fixing bash' });
      const osc = writes.find(w => w.includes('\x1b]0;'))!;
      expect(osc).toContain('\x1b]0;mycc: fixing bash\x07');
      // No double prefix.
      expect(osc).not.toContain('mycc: mycc');
    });

    it('normalizeTitle: strips "mycc - " separator variant', () => {
      const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
      myccTitleTool.handler(ctx, { title: 'mycc - peer work' });
      const osc = writes.find(w => w.includes('\x1b]0;'))!;
      expect(osc).toContain('\x1b]0;mycc: peer work\x07');
    });

    it('normalizeTitle: strips a case-insensitive "MyCC:" prefix', () => {
      const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
      myccTitleTool.handler(ctx, { title: 'MyCC: session work' });
      const osc = writes.find(w => w.includes('\x1b]0;'))!;
      expect(osc).toContain('\x1b]0;mycc: session work\x07');
    });

    it('normalizeTitle: collapses to bare "mycc" when only the prefix is given', () => {
      const ctx = { core: { getWorkDir: () => '/tmp' } } as any;
      myccTitleTool.handler(ctx, { title: 'mycc' });
      const osc = writes.find(w => w.includes('\x1b]0;'))!;
      expect(osc).toContain('\x1b]0;mycc\x07');
    });
  });
});
