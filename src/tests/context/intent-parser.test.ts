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
 * - Verb-object pairing checks (soft warnings)
 * - Object-param pairing checks (soft warnings)
 * - Purpose quality check (min 3 words, soft warning)
 * - formatWarning helper
 */

import { describe, it, expect } from 'vitest';
import {
  parseIntent,
  validateIntent,
  formatWarning,
  VALID_VERBS,
  VALID_OBJECTS,
  VERB_OBJECT_PAIRS,
  OBJECT_PARAMS,
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

  // ═══════════════════════════════════════════════════════════
  // Soft warnings: verb-object pairing
  // ═══════════════════════════════════════════════════════════

  it('should warn when verb-object pair is unusual', () => {
    // INSTALL does not pair with SOURCE
    const parsed = parseIntent('INSTALL SOURCE TO add dependency to project');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('does not typically pair');
    expect(result.warning).toContain('INSTALL');
    expect(result.warning).toContain('SOURCE');
  });

  it('should not warn for valid verb-object pairs', () => {
    for (const v of VALID_VERBS) {
      const allowed = VERB_OBJECT_PAIRS[v] || [];
      for (const o of allowed) {
        const parsed = parseIntent(`${v} ${o} path=test.txt TO perform operation correctly`);
        const result = validateIntent(parsed);
        expect(result.valid).toBe(true);
        // Should not have a verb-object warning
        if (result.warning) {
          expect(result.warning).not.toContain('does not typically pair');
        }
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Soft warnings: object-param pairing
  // ═══════════════════════════════════════════════════════════

  it('should warn when param is not a known attribute of the object', () => {
    // 'timeout' is not an attribute of SOURCE
    const parsed = parseIntent('READ SOURCE timeout=30 TO check source file contents');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('timeout');
    expect(result.warning).toContain('SOURCE');
  });

  it('should warn for each unknown param', () => {
    const parsed = parseIntent('READ SOURCE timeout=5 port=8080 TO check things here');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('timeout');
    expect(result.warning).toContain('port');
  });

  it('should not warn when all params are valid for the object', () => {
    for (const o of VALID_OBJECTS) {
      const allowedParams = OBJECT_PARAMS[o] || [];
      if (allowedParams.length === 0) continue;
      const paramStr = allowedParams.map(p => `${p}=test`).join(' ');
      const parsed = parseIntent(`READ ${o} ${paramStr} TO perform operation correctly`);
      const result = validateIntent(parsed);
      expect(result.valid).toBe(true);
      if (result.warning) {
        expect(result.warning).not.toContain('not a known attribute');
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Soft warnings: purpose quality
  // ═══════════════════════════════════════════════════════════

  it('should warn when purpose is too short (less than 3 words)', () => {
    const parsed = parseIntent('READ SOURCE TO check');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('too short');
    expect(result.warning).toContain('1 word');
  });

  it('should warn when purpose has exactly 2 words', () => {
    const parsed = parseIntent('READ SOURCE TO check dependencies');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('too short');
    expect(result.warning).toContain('2 word');
  });

  it('should warn when no params are given', () => {
    const parsed = parseIntent('READ SOURCE TO check all dependencies');
    const result = validateIntent(parsed);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('no PARAM given');
    expect(result.warning).toContain('SOURCE');
  });
});

describe('formatWarning', () => {
  it('should return empty string when no warning', () => {
    const result = formatWarning({ valid: true });
    expect(result).toBe('');
  });

  it('should return error when no warning but has error', () => {
    const result = formatWarning({ valid: false, error: 'bad' });
    expect(result).toBe('');
  });

  it('should format a warning with prefix', () => {
    const result = formatWarning({ valid: true, warning: 'something is off' });
    expect(result).toContain('[intent hint]');
    expect(result).toContain('something is off');
  });
});

describe('pairing table exports', () => {
  it('should have entries for all valid verbs in VERB_OBJECT_PAIRS', () => {
    for (const verb of VALID_VERBS) {
      expect(VERB_OBJECT_PAIRS[verb]).toBeDefined();
      expect(VERB_OBJECT_PAIRS[verb].length).toBeGreaterThan(0);
    }
  });

  it('should have entries for all valid objects in OBJECT_PARAMS', () => {
    for (const obj of VALID_OBJECTS) {
      expect(OBJECT_PARAMS[obj]).toBeDefined();
      expect(OBJECT_PARAMS[obj].length).toBeGreaterThan(0);
    }
  });

  it('should only reference valid objects in VERB_OBJECT_PAIRS', () => {
    for (const verb of VALID_VERBS) {
      for (const obj of VERB_OBJECT_PAIRS[verb]) {
        expect(VALID_OBJECTS).toContain(obj);
      }
    }
  });
});
