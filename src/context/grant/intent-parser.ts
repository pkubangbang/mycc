/**
 * intent-parser.ts - Parse and validate intent language
 *
 * Intent format: VERB OBJECT [key=value ...] TO PURPOSE
 * PARAM describes attributes of the OBJECT (not the verb).
 */

import type { ParsedIntent, IntentValidation } from './types.js';

// ============================================================================
// Verb & Object definitions
// ============================================================================

export const VALID_VERBS = ['READ', 'WRITE', 'EDIT', 'DELETE', 'BUILD', 'TEST', 'INSTALL', 'RUN'] as const;

export const VALID_OBJECTS = ['SOURCE', 'CONFIG', 'DEPENDENCY', 'ARTIFACT', 'SYSTEM', 'DATA', 'TEMP'] as const;

// ============================================================================
// Verb-object pairing table
// ============================================================================

export const VERB_OBJECT_PAIRS: Record<string, readonly string[]> = {
  READ:       ['SOURCE', 'CONFIG', 'DEPENDENCY', 'ARTIFACT', 'SYSTEM', 'DATA', 'TEMP'],
  WRITE:      ['SOURCE', 'CONFIG', 'ARTIFACT', 'DATA', 'TEMP'],
  EDIT:       ['SOURCE', 'CONFIG', 'DATA'],
  DELETE:     ['SOURCE', 'CONFIG', 'ARTIFACT', 'DATA', 'TEMP'],
  BUILD:      ['SOURCE', 'ARTIFACT'],
  TEST:       ['SOURCE', 'ARTIFACT', 'SYSTEM'],
  INSTALL:    ['DEPENDENCY', 'SYSTEM'],
  RUN:        ['SYSTEM', 'ARTIFACT', 'DATA'],
};

// ============================================================================
// Object-param pairing table
// ============================================================================

export const OBJECT_PARAMS: Record<string, readonly string[]> = {
  SOURCE:      ['path', 'ext', 'name', 'lang'],
  CONFIG:      ['path', 'key', 'name'],
  DEPENDENCY:  ['name', 'version', 'path', 'registry'],
  ARTIFACT:    ['path', 'name', 'type'],
  SYSTEM:      ['command', 'port', 'host', 'name', 'user'],
  DATA:        ['path', 'name', 'format', 'table'],
  TEMP:        ['path', 'name'],
};

// ============================================================================
// Verb meanings (for prompt generation)
// ============================================================================

export const VERB_MEANINGS: Record<string, string> = {
  READ:    'Observe without changing',
  WRITE:   'Create new content',
  EDIT:    'Modify existing content',
  DELETE:  'Remove content',
  BUILD:   'Compile/build artifacts',
  TEST:    'Run tests',
  INSTALL: 'Add dependencies',
  RUN:     'Unknown/generic',
};

// ============================================================================
// Object meanings (for prompt generation)
// ============================================================================

export const OBJECT_MEANINGS: Record<string, string> = {
  SOURCE:      'Source code (.ts, .js, .py)',
  CONFIG:      'Configuration files',
  DEPENDENCY:  'External packages',
  ARTIFACT:    'Build outputs (dist/, build/)',
  SYSTEM:      'System operations',
  DATA:        'Data files, databases',
  TEMP:        'Temporary files',
};

// ============================================================================
// Plan mode behavior per verb (for prompt generation)
// ============================================================================

export const VERB_PLAN_MODE: Record<string, string> = {
  READ:    'Allowed',
  WRITE:   'Blocked',
  EDIT:    'Blocked',
  DELETE:  'Blocked',
  BUILD:   'Blocked',
  TEST:    'Allowed',
  INSTALL: 'Blocked',
  RUN:     'Needs analysis',
};

// ============================================================================
// Read-only vs mutation classification
// ============================================================================

export const READ_ONLY_VERBS = ['READ', 'TEST'] as const;

export const MUTATION_VERBS = ['WRITE', 'EDIT', 'DELETE', 'BUILD', 'INSTALL'] as const;

// ============================================================================
// Purpose quality
// ============================================================================

const MIN_PURPOSE_WORDS = 3;

/**
 * Parse intent string into structured format.
 * Returns null if parsing fails.
 */
export function parseIntent(intent: string): ParsedIntent | null {
  if (!intent || typeof intent !== 'string') {
    return null;
  }

  // Pattern: VERB OBJECT [key=value]* TO PURPOSE
  const match = intent.match(/^([A-Z]+)\s+([A-Z]+)(?:\s+([a-z_]+=[^\s]+))*\s+TO\s+(.+)$/i);

  if (!match) {
    return null;
  }

  const verb = match[1].toUpperCase();
  const object = match[2].toUpperCase();
  const purpose = match[4] ? match[4].trim() : '';

  // Extract key=value params
  const params: Record<string, string> = {};
  const paramMatches = intent.matchAll(/([a-z_]+)=([^\s]+)/gi);
  for (const pm of paramMatches) {
    params[pm[1]] = pm[2];
  }

  return { verb, object, params, purpose, raw: intent };
}

/**
 * Validate parsed intent.
 * Returns validation result with error or soft warning.
 *
 * Errors (hard block): unknown verb, unknown object, missing purpose, invalid format.
 * Warnings (soft): unusual verb-object combo, unusual param for object, weak purpose.
 */
export function validateIntent(parsed: ParsedIntent | null): IntentValidation {
  // --- Null check ---
  if (!parsed) {
    return {
      valid: false,
      error: 'Intent format is invalid or missing',
      hint: 'Use format: VERB OBJECT TO PURPOSE. Example: READ SOURCE TO check dependencies',
    };
  }

  // --- Verb validation ---
  if (!VALID_VERBS.includes(parsed.verb as typeof VALID_VERBS[number])) {
    const verbList = VALID_VERBS.join(', ');
    return {
      valid: false,
      error: `Unknown verb: "${parsed.verb}"`,
      hint: `Use one of: ${verbList}. Example: READ SOURCE TO check dependencies`,
    };
  }

  // --- Object validation ---
  if (!VALID_OBJECTS.includes(parsed.object as typeof VALID_OBJECTS[number])) {
    const objectList = VALID_OBJECTS.join(', ');
    return {
      valid: false,
      error: `Unknown object: "${parsed.object}"`,
      hint: `Use one of: ${objectList}. Example: ${parsed.verb} SOURCE TO ...`,
    };
  }

  // --- Purpose validation ---
  if (!parsed.purpose || parsed.purpose.trim().length === 0) {
    return {
      valid: false,
      error: 'Missing purpose clause',
      hint: 'Add TO purpose at the end. Example: READ SOURCE TO check dependencies',
    };
  }

  // --- Soft warnings below this point ---
  const warnings: string[] = [];

  // Check verb-object pairing
  const allowedObjects = VERB_OBJECT_PAIRS[parsed.verb];
  if (allowedObjects && !allowedObjects.includes(parsed.object)) {
    const allowed = allowedObjects.join(', ');
    warnings.push(`${parsed.verb} does not typically pair with ${parsed.object} (${parsed.verb} pairs with: ${allowed})`);
  }

  // Check object-param pairing
  if (Object.keys(parsed.params).length > 0) {
    const allowedParams = OBJECT_PARAMS[parsed.object];
    if (allowedParams) {
      for (const pk of Object.keys(parsed.params)) {
        if (!allowedParams.includes(pk)) {
          warnings.push(`'${pk}' is not a known attribute of ${parsed.object} (available: ${allowedParams.join(', ')})`);
        }
      }
    }
  } else {
    // No params given — encourage use only if the object actually has defined parameters
    const available = OBJECT_PARAMS[parsed.object] || [];
    if (available.length > 0) {
      warnings.push(`no PARAM given for ${parsed.object}. Consider adding one of: ${available.join(', ')}`);
    }
  }

  // Check purpose quality (word count)
  const purposeWords = parsed.purpose.trim().split(/\s+/).filter(w => w.length > 0);
  if (purposeWords.length < MIN_PURPOSE_WORDS) {
    warnings.push(`PURPOSE is too short: ${purposeWords.length} word(s). Aim for at least ${MIN_PURPOSE_WORDS} words to make intent clear`);
  }

  return warnings.length > 0
    ? { valid: true, warning: warnings.join('; ') }
    : { valid: true };
}

/**
 * Build a formatted warning string from an IntentValidation result.
 * Returns empty string if no warning.
 */
export function formatWarning(validation: IntentValidation): string {
  if (!validation.warning) return '';
  return `\n[intent hint] ${validation.warning}`;
}

/**
 * Check if verb is read-only (safe in plan mode).
 */
export function isReadOnlyVerb(verb: string): boolean {
  return READ_ONLY_VERBS.includes(verb.toUpperCase() as typeof READ_ONLY_VERBS[number]);
}

/**
 * Check if verb is a mutation (blocked in plan mode).
 */
export function isMutationVerb(verb: string): boolean {
  return MUTATION_VERBS.includes(verb.toUpperCase() as typeof MUTATION_VERBS[number]);
}
