/**
 * intent-parser.ts - Parse and validate intent language
 *
 * Intent format: VERB OBJECT [key=value ...] TO PURPOSE
 * PARAM describes attributes of the OBJECT (not the verb).
 *
 * This module implements a rigid, single-pass compiler that detects ANY
 * form of PARAM violation. The tokenizer (`tokenizeParams`) classifies
 * each whitespace-delimited token in the PARAM region with a
 * precedence-ordered ruleset and stops at the first malformed token.
 */

import type { ParsedIntent, IntentValidation } from './types.js';

// ============================================================================
// Verb & Object definitions
// ============================================================================

export const VALID_VERBS = ['READ', 'WRITE', 'EDIT', 'DELETE', 'FIND', 'BUILD', 'TEST', 'INSTALL', 'RUN'] as const;

export const VALID_OBJECTS = ['SOURCE', 'CONFIG', 'DEPENDENCY', 'ARTIFACT', 'SYSTEM', 'DATA', 'TEMP', 'USER'] as const;

// ============================================================================
// Read-only vs mutation classification
// ============================================================================

export const READ_ONLY_VERBS = ['READ', 'FIND', 'TEST'] as const;

export const MUTATION_VERBS = ['WRITE', 'EDIT', 'DELETE', 'BUILD', 'INSTALL'] as const;

// ============================================================================
// Semantic tables (for dynamic prompt generation)
// ============================================================================

export const VERB_MEANINGS: Record<string, string> = {
  READ: 'Inspect or retrieve existing content',
  FIND: 'Search for or locate content',
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

// ============================================================================
// Single-pass PARAM tokenizer
// ============================================================================

/**
 * Result of tokenizing the PARAM region.
 */
interface TokenizeResult {
  wellFormed: Array<{ key: string; value: string }>;
  malformed: { token: string; issue: string } | null;
}

/**
 * Tokenize the PARAM region (text between OBJECT and ` TO `) in a single
 * left-to-right pass.
 *
 * Each whitespace-delimited token is classified by a precedence-ordered
 * ruleset:
 *
 * | Priority | Check (regex)                          | Classification     |
 * |----------|----------------------------------------|--------------------|
 * | 1        | `^[a-z_]+=[^\s=]+$`                    | well-formed        |
 * | 2        | `^[A-Za-z_]+=[^\s=]+$` (not priority 1)| uppercase key      |
 * | 3        | `^[A-Za-z_]+:[^\s]*$`                  | colon separator    |
 * | 4        | `^[a-z_]+=$`                            | empty value        |
 * | 5        | `^=[^\s=]+$`                           | missing key        |
 * | 6        | token contains `=` (not 1-5)           | malformed equals    |
 * | 7        | bare token (no `=`, no `:`)            | missing `=`        |
 *
 * For priority 7 (bare token), the compiler looks ahead to the NEXT token
 * within the same loop iteration:
 * - If a next token exists AND it also has no `=` and no `:` â†?classify the
 *   PAIR as `key value` (missing `=`), consume BOTH tokens.
 * - If it is the last token OR the next token has `=`/`:` â†?classify the
 *   single token as a missing-`=` PARAM.
 *
 * Returns immediately at the first malformed token.
 */
function tokenizeParams(paramRegion: string): TokenizeResult {
  const wellFormed: Array<{ key: string; value: string }> = [];
  const tokens = paramRegion.split(/\s+/).filter((t) => t.length > 0);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Priority 1: well-formed key=value (lowercase/snake_case key, non-empty value, single '=')
    if (/^[a-z_]+=[^\s=]+$/.test(token)) {
      const eqIdx = token.indexOf('=');
      wellFormed.push({ key: token.slice(0, eqIdx), value: token.slice(eqIdx + 1) });
      continue;
    }

    // Priority 2: uppercase key (alphanumeric key with at least one uppercase letter)
    if (/^[A-Za-z_]+=[^\s=]+$/.test(token)) {
      return {
        wellFormed,
        malformed: {
          token,
          issue: `has an uppercase key â€?PARAM keys must be lowercase (snake_case)`,
        },
      };
    }

    // Priority 3: colon separator (key:value or key:)
    if (/^[A-Za-z_]+:[^\s]*$/.test(token)) {
      return {
        wellFormed,
        malformed: {
          token,
          issue: `uses ':' separator â€?PARAMs must use 'key=value' (equals, no spaces)`,
        },
      };
    }

    // Priority 4: empty value (key=)
    if (/^[a-z_]+=$/.test(token)) {
      return {
        wellFormed,
        malformed: {
          token,
          issue: `has empty value â€?PARAMs must be 'key=value' with a non-empty value`,
        },
      };
    }

    // Priority 5: missing key (=value)
    if (/^=[^\s=]+$/.test(token)) {
      return {
        wellFormed,
        malformed: {
          token,
          issue: `is missing a key â€?PARAMs must be 'key=value'`,
        },
      };
    }

    // Priority 6: token contains '=' but doesn't match 1-5 (double equals, extra '=')
    if (token.includes('=')) {
      return {
        wellFormed,
        malformed: {
          token,
          issue: `is malformed â€?PARAMs must be a single 'key=value' (one '=', no spaces)`,
        },
      };
    }

    // Priority 7: bare token (no '=' and no ':') â€?missing '='
    // Look ahead to the next token within the same iteration.
    const nextToken = tokens[i + 1];
    if (nextToken !== undefined && !nextToken.includes('=') && !nextToken.includes(':')) {
      // Two adjacent bare tokens â†?"key value" (missing '=' between them).
      // Consume both tokens (advance index by 1 extra).
      i++;
      return {
        wellFormed,
        malformed: {
          token: `${token} ${nextToken}`,
          issue: `is missing '=' between key and value â€?PARAMs must be 'key=value'`,
        },
      };
    }

    // Last token or next token has '=' / ':' â†?single bare token.
    return {
      wellFormed,
      malformed: {
        token,
        issue: `is missing '=' between key and value â€?PARAMs must be 'key=value'`,
      },
    };
  }

  return { wellFormed, malformed: null };
}

// ============================================================================
// Malformed PARAM detection
// ============================================================================

/**
 * Detect malformed PARAM tokens in the segment between OBJECT and TO.
 *
 * Isolates the PARAM region (text between OBJECT and ` TO `), then runs
 * the single-pass tokenizer. Returns the first malformed token or null
 * if all PARAMs are well-formed (or there are no PARAM-like tokens).
 *
 * @returns the first malformed token's description, or null if all PARAMs are
 *          well-formed (or there are no PARAM-like tokens in the segment).
 */
export function detectMalformedParam(intent: string): { token: string; issue: string } | null {
  if (!intent || typeof intent !== 'string') return null;

  // Isolate the pre-TO segment: VERB OBJECT [params...] before " TO ".
  const headMatch = intent.match(/^([A-Za-z]+)\s+([A-Za-z]+)(.*)$/);
  if (!headMatch) return null;

  const rest = headMatch[3] as string;
  // Find the first " TO " separator (case-insensitive, word-bounded).
  const toIdx = rest.search(/\s+TO\s+/i);
  if (toIdx === -1) return null;

  const paramRegion = rest.slice(0, toIdx).trim();
  if (paramRegion.length === 0) return null;

  const result = tokenizeParams(paramRegion);
  return result.malformed;
}

// ============================================================================
// Intent parsing
// ============================================================================

/**
 * Parse intent string into structured format.
 * Returns null if parsing fails (malformed PARAM, bad structure, etc.).
 */
export function parseIntent(intent: string): ParsedIntent | null {
  if (!intent || typeof intent !== 'string') {
    return null;
  }

  // Extract VERB OBJECT rest â€?anchor at start-of-string (NO leading whitespace).
  const headMatch = intent.match(/^([A-Za-z]+)\s+([A-Za-z]+)(.*)$/);
  if (!headMatch) {
    return null;
  }

  const verb = headMatch[1].toUpperCase();
  const object = headMatch[2].toUpperCase();
  const rest = headMatch[3] as string;

  // Find the first " TO " separator (case-insensitive).
  const toIdx = rest.search(/\s+TO\s+/i);
  if (toIdx === -1) {
    return null;
  }

  const paramRegion = rest.slice(0, toIdx).trim();
  // Purpose is everything after " TO " â€?trim trailing whitespace only.
  const afterTo = rest.slice(toIdx).replace(/^\s+TO\s+/i, '');
  const purpose = afterTo.replace(/\s+$/, '');

  // If there are params, tokenize them. A malformed PARAM â†?return null.
  let params: Record<string, string> = {};
  if (paramRegion.length > 0) {
    const tokenized = tokenizeParams(paramRegion);
    if (tokenized.malformed) {
      return null;
    }
    for (const { key, value } of tokenized.wellFormed) {
      params[key] = value;
    }
  }

  return { verb, object, params, purpose, raw: intent };
}

// ============================================================================
// Intent validation
// ============================================================================

/**
 * Validate parsed intent.
 * Returns validation result with error or success.
 *
 * Errors (hard block): unknown verb, unknown object, missing purpose, invalid
 * format, malformed PARAM format.
 *
 * When `parsed` is null, we run a malformed-PARAM scan on the raw intent (if
 * provided via the second argument) so that a malformed PARAM is reported with
 * a targeted error instead of the generic "Intent format is invalid or
 * missing".
 */
export function validateIntent(parsed: ParsedIntent | null, raw?: string): IntentValidation {
  // --- Malformed PARAM check (runs before the generic null error so a
  //     malformed PARAM is reported specifically even when the overall
  //     regex failed and parseIntent returned null) ---
  const malformed = detectMalformedParam(raw ?? parsed?.raw ?? '');
  if (malformed) {
    return {
      valid: false,
      error: `Malformed PARAM: "${malformed.token}" ${malformed.issue}`,
      hint: `Use format: key=value (lowercase snake_case key, no spaces). Example: READ SOURCE path=src/utils.ts TO verify imports`,
    };
  }

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

// ============================================================================
// Verb classification helpers
// ============================================================================

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
