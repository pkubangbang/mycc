import { describe, it, expect } from 'vitest';
import { filterCliXml } from '../../loop/agent-exec.js';

/**
 * replay-buffer.test.ts - Tests for the CLIXML noise filter (filterCliXml)
 *
 * The previous version of this file tested `Buffer.concat` directly, which
 * exercised no production code. filterCliXml is the exported, testable piece
 * of the subprocess-output pipeline: it strips PowerShell CLIXML noise from
 * stderr chunks while preserving real stderr text.
 */

describe('filterCliXml', () => {
  it('should return the chunk untouched when there is no CLIXML marker', () => {
    const chunk = Buffer.from('plain stderr text');
    const result = filterCliXml(chunk);
    expect(result.toString('utf-8')).toBe('plain stderr text');
  });

  it('should return the same Buffer instance on the fast path (no CLIXML)', () => {
    const chunk = Buffer.from('no noise here');
    expect(filterCliXml(chunk)).toBe(chunk);
  });

  it('should strip a leading "#< CLIXML" marker', () => {
    const chunk = Buffer.from('#< CLIXML\nreal error message');
    const result = filterCliXml(chunk).toString('utf-8');
    expect(result).toBe('real error message');
  });

  it('should strip a complete <Objs>...</Objs> block', () => {
    const chunk = Buffer.from('<Objs Version="1.0"><Obj>noise</Obj></Objs>real text');
    const result = filterCliXml(chunk).toString('utf-8');
    expect(result).toBe('real text');
  });

  it('should strip an unterminated trailing <Objs fragment', () => {
    const chunk = Buffer.from('prefix <Objs Version="1.0"><Obj>unterminated');
    const result = filterCliXml(chunk).toString('utf-8');
    expect(result).toBe('prefix ');
  });

  it('should preserve real stderr text around CLIXML blocks', () => {
    const chunk = Buffer.from('warning: something\n#< CLIXML\n<Objs><Obj>x</Obj></Objs>\nstill here');
    const result = filterCliXml(chunk).toString('utf-8');
    expect(result).toContain('warning: something');
    expect(result).toContain('still here');
    expect(result).not.toContain('<Objs');
  });

  it('should handle a chunk that is only CLIXML noise', () => {
    const chunk = Buffer.from('#< CLIXML\n<Objs><Obj>a</Obj></Objs>');
    const result = filterCliXml(chunk).toString('utf-8');
    expect(result).toBe('');
  });

  it('should handle an empty chunk', () => {
    const chunk = Buffer.from('');
    const result = filterCliXml(chunk).toString('utf-8');
    expect(result).toBe('');
  });

  it('should handle a chunk with only the CLIXML marker and no block', () => {
    const chunk = Buffer.from('#< CLIXML');
    const result = filterCliXml(chunk).toString('utf-8');
    expect(result).toBe('');
  });

  it('should handle a chunk with only an <Objs marker and no closing tag', () => {
    const chunk = Buffer.from('<Objs Version="1.0">');
    const result = filterCliXml(chunk).toString('utf-8');
    expect(result).toBe('');
  });

  it('should handle unicode text that is not CLIXML', () => {
    const chunk = Buffer.from('日本語のエラー 🎉');
    const result = filterCliXml(chunk).toString('utf-8');
    expect(result).toBe('日本語のエラー 🎉');
  });
});
