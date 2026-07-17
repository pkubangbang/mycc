/**
 * collect-reactivation.test.ts - Unit tests for the reactivation JSON parser
 * in the COLLECT state. The `checkReactivation` flow asks the LLM (via
 * forkChat) to return a JSON array; the parser must tolerate surrounding
 * noise and reject malformed output without throwing.
 */

import { describe, it, expect } from 'vitest';
import { parseReactivationResult } from '../../../loop/states/collect.js';

describe('parseReactivationResult', () => {
  it('should parse a clean JSON array', () => {
    const raw = '[{"id":2,"hash":"abc12345","reopen":true,"reason":"users table changed"}]';
    const result = parseReactivationResult(raw);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0]).toEqual({ id: 2, hash: 'abc12345', reopen: true, reason: 'users table changed' });
  });

  it('should parse multiple entries', () => {
    const raw = '[{"id":1,"hash":"h1","reopen":false,"reason":"no change"},{"id":2,"hash":"h2","reopen":true,"reason":"changed"}]';
    const result = parseReactivationResult(raw);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].reopen).toBe(false);
    expect(result![1].reopen).toBe(true);
  });

  it('should extract a JSON array from surrounding noise text', () => {
    const raw = 'Here is my evaluation:\n[{"id":2,"hash":"abc","reopen":true,"reason":"x"}]\nHope that helps!';
    const result = parseReactivationResult(raw);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].id).toBe(2);
  });

  it('should return null for non-JSON text', () => {
    expect(parseReactivationResult('REACTIVATE because users changed')).toBeNull();
    expect(parseReactivationResult('')).toBeNull();
    expect(parseReactivationResult('   ')).toBeNull();
  });

  it('should return null for JSON that is not an array', () => {
    expect(parseReactivationResult('{"id":2,"reopen":true}')).toBeNull();
    expect(parseReactivationResult('"just a string"')).toBeNull();
    expect(parseReactivationResult('42')).toBeNull();
  });

  it('should return null for malformed JSON array (unclosed)', () => {
    expect(parseReactivationResult('[{"id":2,"reopen":true')).toBeNull();
  });

  it('should tolerate whitespace around the JSON array', () => {
    const raw = '   \n  [{"id":5,"hash":"h","reopen":false,"reason":"skip"}]  \n  ';
    const result = parseReactivationResult(raw);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].id).toBe(5);
  });

  it('should keep entries even if some fields are missing (caller guards per-entry)', () => {
    // The parser only checks Array.isArray; per-entry type validation is done
    // by the caller. So a partially-shaped entry passes through the parser.
    const raw = '[{"id":2,"hash":"abc","reopen":true}]';
    const result = parseReactivationResult(raw);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    // reason missing — caller will handle via optional access
    expect(result![0].reason).toBeUndefined();
  });
});