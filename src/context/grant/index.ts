/**
 * index.ts - Barrel export for grant module
 */

// Types
export type { ParsedIntent, IntentValidation, BashJudgeResult, DangerousCommand, GrantRequest, GrantTool } from './types.js';

// Intent parser
export { parseIntent, validateIntent, isReadOnlyVerb, isMutationVerb, VALID_VERBS, VALID_OBJECTS, READ_ONLY_VERBS, MUTATION_VERBS } from './intent-parser.js';

// Dangerous commands
export { DANGEROUS_COMMANDS, checkDangerousCommand } from './dangerous-commands.js';

// Bash judge
export { judgeBash } from './bash-judge.js';

// Grant evaluator
export { evaluateGrant } from './grant-evaluator.js';