/**
 * ConfusionCalculator - Specialist system for measuring LLM confusion
 *
 * Calculates a "confusion score" based on tool usage patterns:
 * - Each assistant response contributes +1 (spinning without progress)
 * - Exploration tools (read, search) contribute 0
 * - Action tools (write, edit) contribute -1 (progress)
 * - Errors contribute +2 (stuck)
 * - Repetition contributes +1 (potential loop)
 */
/** Check if a tool result string indicates an error */
function isErrorResult(result: string): boolean {
  if (!result) return false;
  const lower = result.toLowerCase();
  // Common error prefixes
  if (lower.startsWith('error:') || lower.startsWith('error ') || lower.startsWith('fatal:')) return true;
  // Shell exit codes
  if (/command failed with exit code \d+/.test(lower)) return true;
  // Node.js error patterns
  if (lower.includes('eacces') || lower.includes('enoent') || lower.includes('eperm')) return true;
  // Permission denied
  if (lower.includes('permission denied')) return true;
  // Not found / does not exist
  if (lower.includes('not found') || lower.includes('does not exist') || lower.includes('no such file')) return true;
  return false;
}

export class ConfusionCalculator {
  // Tools that are purely exploratory (information gathering)
  private static readonly EXPLORATION_TOOLS = new Set([
    'read_file',
    'web_search',
    'web_fetch',
    'brief', // Status messages
    'issue_list', // Listing issues
    'wt_print', // Listing worktrees
    'bg_print', // Listing background tasks
    'tm_print', // Listing teammates
    'question', // Asking questions
  ]);

  // Tools that modify state (progress indicators)
  private static readonly ACTION_TOOLS = new Set([
    'write_file',
    'edit_file',
    'todo_write',
    'issue_create',
    'issue_close',
    'issue_claim',
    'issue_comment',
    'blockage_create',
    'blockage_remove',
    'tm_create',
    'tm_remove',
    'wt_create',
    'wt_remove',
    'bg_create',
    'bg_remove',
    'mail_to',
    'broadcast',
  ]);

  // Read-only bash commands (exploration)
  private static readonly READ_ONLY_BASH = /^(ls|cat|pwd|head|tail|wc|find|which|git\s+(status|log|diff|branch|show|ls-files))/;

  private score: number = 0;
  private recentToolCalls: string[] = [];
  private threshold: number;

  constructor(threshold: number = 10) {
    this.threshold = threshold;
  }

  private isExplorationToolUse(toolName: string, args?: Record<string, unknown>): boolean {
    if (ConfusionCalculator.ACTION_TOOLS.has(toolName)) {
      return false;
    }

    if (ConfusionCalculator.EXPLORATION_TOOLS.has(toolName)) {
      return true;
    }

    if (toolName === 'bash' && args?.command) {
      const cmd = String(args.command);
      return ConfusionCalculator.READ_ONLY_BASH.test(cmd);
    }

    return false;
  }

  /** Called when a tool is invoked */
  onToolCall(toolName: string, args?: Record<string, unknown>): void {
    const isExplorationTool = this.isExplorationToolUse(toolName, args);
    if (isExplorationTool) {
      if (toolName === 'question') {
        this.score = Math.max(this.score - 2, 0);
      }
    } else {
      // actions
      if (this.recentToolCalls.slice(-5).includes(toolName)) {
        // consecutive actions
        if (toolName === 'mail_to') {
          // mail_to is highly confusing
          this.score += 2;
        }
      } else {
        // burst action - reduces confusion
        this.score = Math.max(this.score - 1, 0);
      }
    }

    this.recentToolCalls.push(toolName);
  }

  /** Called on each assistant response (turn) */
  onAssistantResponse(): void {
    this.score += 1;
  }

  /** Called when tool result contains error */
  onError(result: string): void {
    if (isErrorResult(result)) {
      this.score += 2;
    }
  }

  /** Check if hint should be generated */
  needsHint(): boolean {
    return this.score >= this.threshold;
  }

  /** Reset on user intervention */
  reset(): void {
    this.score = 0;
    this.recentToolCalls = [];
  }

  /** Get current score (for testing/debugging) */
  getScore(): number {
    return this.score;
  }
}