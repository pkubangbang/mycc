/**
 * intent-parser.test.ts - Unit tests for parseIntent and validateIntent
 *
 * Tests the intent language parser that validates the format:
 * VERB OBJECT [key=value ...] TO PURPOSE
 *
 * Key behaviors:
 * - Case-insensitive matching
 * - Optional key=value parameters (attributes of OBJECT)
 * - Whitespace tolerance
 * - Valid verb and object enumeration
 * - Hard errors for invalid verbs, objects, missing purpose
 */

import { describe, it, expect } from 'vitest';
import {
  parseIntent,
  validateIntent,
  VALID_VERBS,
  VALID_OBJECTS,
} from '../../context/grant/intent-parser.js';

describe('parseIntent', () => {
  // ── Happy path ────────────────────────────────────────────

  it('should parse a basic intent: VERB OBJECT TO PURPOSE', () => {
    const result = parseIntent('READ SOURCE TO check dependencies');
    expect(result).not.toBeNull();
    expect(result!.verb).toBe('READ');
    expect(result!.object).toBe('SOURCE');
    expect(result!.purpose).toBe('check dependencies');
    expect(result!.params).toEqual({});
    expect(result!.raw).toBe('READ SOURCE TO check dependencies');
  });

  it('should parse EDIT CONFIG with long purpose', () => {
    const result = parseIntent('EDIT CONFIG TO update build settings for production');
    expect(result).not.toBeNull();
    expect(result!.verb).toBe('EDIT');
    expect(result!.object).toBe('CONFIG');
    expect(result!.purpose).toBe('update build settings for production');
  });

  it('should parse with key=value parameters', () => {
    const result = parseIntent('READ SOURCE path=src/utils.ts TO verify imports');
    expect(result).not.toBeNull();
    expect(result!.verb).toBe('READ');
    expect(result!.object).toBe('SOURCE');
    expect(result!.params).toEqual({ path: 'src/utils.ts' });
    expect(result!.purpose).toBe('verify imports');
  });

  it('should parse with multiple key=value parameters', () => {
    const result = parseIntent('READ CONFIG path=package.json key=version TO verify config settings');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ path: 'package.json', key: 'version' });
  });

  // ── Case insensitivity ────────────────────────────────────

  it('should normalize lowercase verb and object to uppercase', () => {
    const result = parseIntent('read source TO check stuff');
    expect(result).not.toBeNull();
    expect(result!.verb).toBe('READ');
    expect(result!.object).toBe('SOURCE');
  });

  it('should normalize mixed-case verb and object', () => {
    const result = parseIntent('Read Source TO check stuff');
    expect(result).not.toBeNull();
    expect(result!.verb).toBe('READ');
    expect(result!.object).toBe('SOURCE');
  });

  it('should preserve purpose case', () => {
    const result = parseIntent('READ SOURCE TO Check Dependencies in NPM');
    expect(result).not.toBeNull();
    expect(result!.purpose).toBe('Check Dependencies in NPM');
  });

  // ── All valid verbs ───────────────────────────────────────

  for (const verb of VALID_VERBS) {
    it(`should accept valid verb: ${verb}`, () => {
      const result = parseIntent(`${verb} SOURCE TO do something`);
      expect(result).not.toBeNull();
      expect(result!.verb).toBe(verb);
    });
  }

  // ── All valid objects ─────────────────────────────────────

  for (const obj of VALID_OBJECTS) {
    it(`should accept valid object: ${obj}`, () => {
      const result = parseIntent(`READ ${obj} TO do something`);
      expect(result).not.toBeNull();
      expect(result!.object).toBe(obj);
    });
  }

  // ── Whitespace tolerance ──────────────────────────────────

  it('should tolerate extra spaces between tokens', () => {
    const result = parseIntent('READ    SOURCE       TO    check    stuff');
    expect(result).not.toBeNull();
    expect(result!.verb).toBe('READ');
    expect(result!.object).toBe('SOURCE');
    expect(result!.purpose).toBe('check    stuff');
  });

  it('should NOT tolerate leading whitespace (strict start-of-line)', () => {
    const result = parseIntent('   READ SOURCE TO check');
    expect(result).toBeNull();
  });

  it('should tolerate trailing whitespace', () => {
    const result = parseIntent('READ SOURCE TO check   ');
    expect(result).not.toBeNull();
    expect(result!.purpose).toBe('check');
  });

  // ── "TO" in purpose ───────────────────────────────────────

  it('should handle "TO" appearing inside the purpose text', () => {
    const result = parseIntent('READ SOURCE TO copy file TO destination');
    expect(result).not.toBeNull();
    expect(result!.purpose).toBe('copy file TO destination');
  });

  // ── Param parsing with snake_case keys ────────────────────

  it('should parse snake_case param keys', () => {
    const result = parseIntent('READ DATA path=users.csv format=csv TO inspect data');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ path: 'users.csv', format: 'csv' });
  });

  // ── Null/empty/invalid input ──────────────────────────────

  it('should return null for empty string', () => {
    expect(parseIntent('')).toBeNull();
  });

  it('should return null for whitespace-only string', () => {
    expect(parseIntent('   ')).toBeNull();
  });

  it('should return null for undefined input', () => {
    expect(parseIntent(undefined as unknown as string)).toBeNull();
  });

  it('should return null for null input', () => {
    expect(parseIntent(null as unknown as string)).toBeNull();
  });

  it('should return null for non-string input (number)', () => {
    expect(parseIntent(42 as unknown as string)).toBeNull();
  });

  // ── Missing TO separator ──────────────────────────────────

  it('should return null when TO separator is missing', () => {
    expect(parseIntent('READ SOURCE check dependencies')).toBeNull();
  });

  it('should return null for intent with only verb and object', () => {
    expect(parseIntent('READ SOURCE')).toBeNull();
  });

  // ── Missing verb or object ────────────────────────────────

  it('should return null when verb is missing', () => {
    expect(parseIntent('SOURCE TO check')).toBeNull();
  });

  it('should return null when object is missing', () => {
    expect(parseIntent('READ TO check')).toBeNull();
  });

  it('should return null when only TO and purpose present', () => {
    expect(parseIntent('TO check')).toBeNull();
  });

  // ── "TO" edge cases ───────────────────────────────────────

  it('should not match "TO " alone without preceding verb/object', () => {
    expect(parseIntent('TO something')).toBeNull();
  });
});

describe('validateIntent', () => {
  // ═══════════════════════════════════════════════════════════
  // Valid intents (no warnings)
  // ═══════════════════════════════════════════════════════════

  it('should validate a fully correct parsed intent', () => {
    const parsed = parseIntent('READ SOURCE path=src/utils.ts TO verify import resolution');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.hint).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it('should validate with valid params and long purpose', () => {
    const parsed = parseIntent('INSTALL DEPENDENCY name=express version=4.18.0 TO add web framework for routing');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('should validate BUILD ARTIFACT with valid param', () => {
    const parsed = parseIntent('BUILD ARTIFACT name=dist TO compile TypeScript output');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('should validate TEST SYSTEM with valid param', () => {
    const parsed = parseIntent('TEST SYSTEM command=curl TO verify endpoint is reachable');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════
  // Hard errors
  // ═══════════════════════════════════════════════════════════

  it('should reject null parsed intent', () => {
    const result = validateIntent(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid or missing');
    expect(result.hint).toContain('VERB OBJECT TO PURPOSE');
  });

  it('should reject unknown verb', () => {
    const parsed = parseIntent('FLY SOURCE TO go somewhere');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown verb');
    expect(result.error).toContain('FLY');
  });

  it('should list all valid verbs in hint for unknown verb', () => {
    const parsed = parseIntent('JUMP CONFIG TO test');
    const result = validateIntent(parsed);
    for (const verb of VALID_VERBS) {
      expect(result.hint!).toContain(verb);
    }
  });

  it('should reject unknown object', () => {
    const parsed = parseIntent('READ PLANET TO explore');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown object');
    expect(result.error).toContain('PLANET');
  });

  it('should reject when purpose is empty', () => {
    const parsed = parseIntent('READ SOURCE TO ');
    expect(parsed).toBeNull();
    const result = validateIntent(parsed);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid or missing');
  });

  it('should reject when purpose is only whitespace after TO', () => {
    const parsed = parseIntent('READ SOURCE TO    ');
    expect(parsed).not.toBeNull();
    expect(parsed!.purpose).toBe('');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing purpose');
  });
});
