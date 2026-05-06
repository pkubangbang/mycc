/**
 * input-provider.ts - Pluggable input sources for the state machine
 *
 * The InputProvider abstraction decouples input acquisition from the
 * state machine loop, enabling autonomous modes by swapping providers.
 */

import chalk from 'chalk';
import { agentIO } from './agent-io.js';

// ============================================================================
// Interface
// ============================================================================

export interface InputProvider {
  /** Human-readable name for logging */
  readonly name: string;

  /**
   * Get the next input for the agent.
   * @returns The input string, or null to skip prompt (autonomous mode)
   */
  getInput(): Promise<string | null>;

  /**
   * Ask whether to retry after a transient error.
   * @returns true to retry, false to give up
   */
  promptRetry(errorMessage: string): Promise<boolean>;
}

// ============================================================================
// UserInputProvider — normal interactive mode
// ============================================================================

/**
 * Function type to get current mode
 */
export type GetModeFn = () => 'plan' | 'normal';

export class UserInputProvider implements InputProvider {
  readonly name = 'user';
  private getMode: GetModeFn;

  constructor(getMode: GetModeFn) {
    this.getMode = getMode;
  }

  async getInput(): Promise<string | null> {
    const mode = this.getMode();
    if (mode === 'plan') {
      return agentIO.ask(chalk.bgBlueBright.bold.whiteBright('plan >> '), true);
    }
    return agentIO.ask(chalk.bgYellow.black('agent >> '), true);
  }

  async promptRetry(errorMessage: string): Promise<boolean> {
    console.error();
    console.error(chalk.red(`Network error: ${errorMessage}`));
    console.log(chalk.gray('─'.repeat(40)));
    const answer = await agentIO.ask(chalk.cyan('Retry? [Y/n] > '), true);
    return answer.toLowerCase() !== 'n' && answer.toLowerCase() !== 'no';
  }
}

// ============================================================================
// AutonomousProvider — skip prompt entirely
// ============================================================================

export class AutonomousProvider implements InputProvider {
  readonly name = 'autonomous';

  async getInput(): Promise<string | null> {
    return null; // Skip prompt → COLLECT continues without user input
  }

  async promptRetry(_errorMessage: string): Promise<boolean> {
    return true; // Always retry transient errors
  }
}
