/**
 * triologue/types.ts - Shared type definitions for the Triologue layer family
 *
 * Extracted from triologue.ts (Phase 1 of the layered refactor) so the
 * sibling modules (store, pending-tools, compact, wrap-up, checkpoint,
 * tp-guards) can share these types without importing the facade class.
 *
 * The facade (src/loop/triologue.ts) re-exports everything from this file,
 * so existing consumers importing from '../loop/triologue.js' are unaffected.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

import type { Message } from '../../types.js';

export interface MisorderWarning {
  from: Role;
  to: Role;
  gap: 'missing_assistant' | 'missing_tool_response' | 'unexpected_duplicate' | 'invalid_sequence';
  context: { lastMessage?: Message; newMessage?: Partial<Message> };
}

export interface ToolAlignmentWarning {
  functionName: string;
  toolCallId?: string;
  issue: 'no_pending_calls' | 'id_not_found' | 'name_mismatch' | 'orphan_result';
  expectedId?: string;
  expectedName?: string;
}

export interface TriologueOptions {
  /** Token threshold for auto-compact (default: 50000) */
  tokenThreshold?: number;
  /** Result size threshold in chars (default: 20000) */
  resultThreshold?: number;
  /** Message threshold for hint round (default: 10) */
  hintThreshold?: number;
  /** Called when misordered role transition detected */
  onMisorder?: (warning: MisorderWarning) => void;
  /** Called when tool call/result alignment issue detected */
  onToolMisalign?: (warning: ToolAlignmentWarning) => void;
  /** Called when auto-compact is triggered */
  onCompact?: (transcriptPath: string) => void;
  /** Called after each message is added */
  onMessage?: (messages: Message[]) => void;

  /** Callback to retrieve wiki domains for knowledge persistence during compact */
  getWikiDomains?: () => Promise<Array<{ domain_name: string; description?: string }>>;
  /** Optional duplication report provider for hint round */
  getDuplicationReport?: () => string;
}

export interface ResolvedTriologueOptions {
  tokenThreshold: number;
  resultThreshold: number;
  hintThreshold: number;
  onMisorder: (warning: MisorderWarning) => void;
  onToolMisalign: (warning: ToolAlignmentWarning) => void;
  onCompact: (transcriptPath: string) => void;
  onMessage: (messages: Message[]) => void;
  getWikiDomains?: () => Promise<Array<{ domain_name: string; description?: string }>>;
  getDuplicationReport?: () => string;
}

export interface CheckpointInfo {
  id: string;
  description: string;
  if_abandoned?: string;
}