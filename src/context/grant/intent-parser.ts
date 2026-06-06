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

export const VALID_OBJECTS = ['SOURCE', 'CONFIG', 'DEPENDENCY', 'ARTIFACT', 'SYSTEM', 'DATA', 'TEMP', 'USER'] as const;

// ============================================================================
// Read-only vs mutation classification
// ============================================================================

export const READ_ONLY_VERBS = ['READ', 'TEST'] as const;

export const MUTATION_VERBS = ['WRITE', 'EDIT', 'DELETE', 'BUILD', 'INSTALL'] as const;

// ============================================================================
// Semantic tables (for dynamic prompt generation)
// ============================================================================

export const VERB_MEANINGS: Record<string, string> = {
  READ: 'Inspect or retrieve existing content',
  WRITE: 'Create or overwrite content',
  EDIT: 'Modify existing content in-place',
  DELETE: 'Remove files, packages, or resources',
  BUILD: 'Compile, transpile, or transform source',
  TEST: 'Verify correctness or behavior',
  INSTALL: 'Fetch and set up dependencies',
  RUN: 'Execute a command or process',
};

export const OBJECT_MEANINGS: Record<string, string> = {
  SOURCE: 'Source code files (*.ts, *.js, etc.)',
  CONFIG: 'Configuration files and environment settings',
  DEPENDENCY: 'Third-party packages and libraries',
  ARTIFACT: 'Build outputs, binaries, and generated files',
  SYSTEM: 'OS-level operations and environment state',
  DATA: 'Data files, databases, and structured content',
  TEMP: 'Temporary or intermediate files',
  USER: 'User interaction and terminal sessions',
};

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
 * Returns validation result with error or success.
 *
 * Errors (hard block): unknown verb, unknown object, missing purpose, invalid format.
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

  return { valid: true };
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
