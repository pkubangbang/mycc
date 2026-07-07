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
 * Detect malformed PARAM tokens in the segment between OBJECT and TO.
 *
 * A well-formed PARAM is `key=value` where the key is `[a-z_]+` and the value
 * is any non-whitespace run. This helper inspects each whitespace-delimited
 * token in the pre-TO segment and flags any token that *looks* like an
 * attempted PARAM (contains a `:` or `=`, or is a bare `key:value` / `key`
 * with an adjacent value) but does NOT match the canonical `key=value` form.
 *
 * Recognized malformed forms:
 *  - `key:value`  — colon separator instead of `=`
 *  - `key value`  — missing `=` entirely (two adjacent tokens after OBJECT)
 *  - `key=`       — empty value
 *  - `=value`     — missing key
 *  - `Key=value`  — uppercase key (keys must be lowercase / snake_case)
 *
 * @returns the first malformed token's description, or null if all PARAMs are
 *          well-formed (or there are no PARAM-like tokens in the segment).
 */
export function detectMalformedParam(intent: string): { token: string; issue: string } | null {
  if (!intent || typeof intent !== 'string') return null;

  // Isolate the pre-TO segment: VERB OBJECT [params...] before " TO ".
  // We match VERB and OBJECT loosely, then take everything up to the first
  // ` TO ` (case-insensitive) as the PARAM region.
  const headMatch = intent.match(/^\s*([A-Za-z]+)\s+([A-Za-z]+)(.*)$/);
  if (!headMatch) return null;

  const rest = headMatch[3] as string;
  // Find the first " TO " separator (case-insensitive, word-bounded).
  const toIdx = rest.search(/\s+TO\s+/i);
  if (toIdx === -1) return null;

  const paramRegion = rest.slice(0, toIdx).trim();
  if (paramRegion.length === 0) return null;

  const tokens = paramRegion.split(/\s+/).filter((t) => t.length > 0);

  for (const token of tokens) {
    // Well-formed: lowercase/snake_case key, `=`, non-empty value, no spaces.
    if (/^[a-z_]+=[^\s=]+$/.test(token)) continue;

    // Malformed — classify the issue for a targeted hint.
    let issue: string;
    if (/^[A-Za-z_]+:$/.test(token) || /^[A-Za-z_]+:[^\s]+$/.test(token)) {
      issue = `uses ':' separator — PARAMs must use 'key=value' (equals, no spaces)`;
    } else if (/^[a-z_]+=$/i.test(token)) {
      issue = `has empty value — PARAMs must be 'key=value' with a non-empty value`;
    } else if (/^=[^\s]+$/.test(token)) {
      issue = `is missing a key — PARAMs must be 'key=value'`;
    } else if (/^[A-Za-z_]+=[^\s=]+$/.test(token) && !/^[a-z_]+=[^\s=]+$/.test(token)) {
      // Alphanumeric key with at least one uppercase letter (e.g. Path=, MyKey=).
      // The value side allows no '=' so double-equals stays in the bucket below.
      issue = `has an uppercase key — PARAM keys must be lowercase (snake_case)`;
    } else if (token.includes('=')) {
      // e.g. key==value, key=value=extra, =value=, etc.
      issue = `is malformed — PARAMs must be a single 'key=value' (one '=', no spaces)`;
    } else {
      // A bare token with no '=' and no ':' — only flag if it sits where a
      // PARAM is expected. We treat a lone alphanumeric/snake token as a
      // missing-'=' case only when it is not the last token before TO (a
      // trailing bare token is more likely just stray text). To keep this
      // targeted, flag bare tokens that look like an attempted key:value pair
      // split across two tokens (key value) — detect via a colon-less token
      // immediately followed by another token.
      continue;
    }
    return { token, issue };
  }

  // Second pass: detect `key value` (missing '=') — two adjacent tokens where
  // the first looks like a key (lowercase/snake, no separator) and the second
  // looks like a value (not itself a key=value). This catches the common
  // "path src/utils.ts" mistake.
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (/^[a-z_]+$/.test(a) && !b.includes('=') && !b.includes(':')) {
      return { token: `${a} ${b}`, issue: `is missing '=' between key and value — PARAMs must be 'key=value'` };
    }
  }

  return null;
}

/**
 * Validate parsed intent.
 * Returns validation result with error or success.
 *
 * Errors (hard block): unknown verb, unknown object, missing purpose, invalid format,
 * malformed PARAM format.
 *
 * When `parsed` is null, we run a malformed-PARAM scan on the raw intent (if
 * provided via the second argument) so that a malformed PARAM is reported with
 * a targeted error instead of the generic "Intent format is invalid or missing".
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
