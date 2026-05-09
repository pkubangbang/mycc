/**
 * types.ts - Type definitions for the grant system
 */

/**
 * Parsed intent from bash tool
 */
export interface ParsedIntent {
  verb: string;           // e.g., 'READ', 'WRITE', 'RUN'
  object: string;         // e.g., 'SOURCE', 'CONFIG'
  params: Record<string, string>;  // key=value pairs
  purpose: string;        // The TO clause
  raw: string;            // Original intent string
}

/**
 * Result of intent validation
 */
export interface IntentValidation {
  valid: boolean;
  error?: string;         // Human-readable error for LLM to fix
  hint?: string;          // Suggested correction
}

/**
 * Result of bash command judging
 */
export interface BashJudgeResult {
  decision: 'allow' | 'block' | 'ask_user';
  reason?: string;
}

/**
 * Dangerous command pattern
 */
export interface DangerousCommand {
  pattern: RegExp;
  reason: string;
  category: 'destructive' | 'irreversible' | 'system';
}

/**
 * Grant request types
 */
export type GrantTool = 'write_file' | 'edit_file' | 'bash';

/**
 * Grant request payload
 */
export interface GrantRequest {
  tool: GrantTool;
  path?: string;
  command?: string;
  intent?: string;  // Required for bash tool
}