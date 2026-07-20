/**
 * web-input-provider.ts - Sole InputProvider bridging WebSocket ↔ state machine
 *
 * WebInputProvider is the **only** InputProvider passed to the state machine.
 * It internally switches between WebSocket and terminal based on hub.isRunning():
 *   - serve running  → wait for WebSocket input via hub.waitForInput()
 *   - serve stopped  → delegate to UserInputProvider (terminal)
 *
 * No wrapper, no swap at runtime. The hub.isRunning() check after every await
 * handles the case where serve exits while getInput() is blocking (ESC/exit/
 * timeout called abortInput() which resolved waitForInput() with null).
 */

import type { InputProvider } from '../loop/input-provider.js';
import { UserInputProvider } from '../loop/input-provider.js';
import { ServeHub } from './serve-hub.js';
import { agentIO } from '../loop/agent-io.js';

export class WebInputProvider implements InputProvider {
  readonly name = 'web';
  private hub: ServeHub;
  private userProvider: UserInputProvider; // CLI fallback when serve not running

  constructor(hub: ServeHub, userProvider: UserInputProvider) {
    this.hub = hub;
    this.userProvider = userProvider;
  }

  async getInput(initialContent?: string): Promise<string | null> {
    if (!this.hub.isRunning()) {
      // Serve not running — delegate to terminal
      return this.userProvider.getInput(initialContent);
    }

    // Serve running — wait for WebSocket input.
    // Clear any stuck neglection flag from a prior "停止" (interrupt) click:
    // the terminal ask() clears neglectedModeFlag + flushes buffered output
    // before showing the prompt (agent-io.ts line 569-570). The serve path
    // must do the same, otherwise output stays buffered/invisible and the
    // next LLM call runs in neglected mode (empty tools → text-only reply).
    agentIO.setNeglectedMode(false);
    agentIO.flushOutput();
    this.hub.broadcast('prompt', initialContent || '');
    const result = await this.hub.waitForInput();

    // After await, check if serve was stopped during the wait.
    // abortInput() resolved waitForInput() with null — fall back to terminal.
    if (!this.hub.isRunning()) {
      return this.userProvider.getInput(initialContent);
    }
    return result;
  }

  async promptRetry(errorMessage: string): Promise<boolean> {
    if (!this.hub.isRunning()) {
      return this.userProvider.promptRetry(errorMessage);
    }

    // Same neglection reset as getInput() — see comment there.
    agentIO.setNeglectedMode(false);
    agentIO.flushOutput();
    this.hub.broadcast('error', `Error: ${errorMessage}`);

    // Use an interactive confirm CARD instead of a plain prompt broadcast.
    // A plain 'Retry? [Y/n]' prompt sets state.showRetry in the webui, which
    // DISABLES the chat input box (ChatInput.vue) — the only enabled escape
    // is the small amber Retry button in the top StatusBar, which is easy to
    // miss and disabled entirely when the WS drops. That left the user with a
    // frozen-looking UI and the backend blocked forever on waitForInput()
    // with no terminal fallback (the CLI was unreachable too). A confirm card
    // renders an inline clickable Yes/No next to the bubble (CardItem.vue)
    // and keeps the regular input box enabled.
    const cardId = `retry-${Date.now()}`;
    this.hub.broadcastCard({
      type: 'card',
      cardId,
      query: 'Retry?',
      kind: 'confirm',
      options: [
        { label: 'Yes', value: 'y' },
        { label: 'No', value: 'n' },
      ],
    });
    const answer = await this.hub.waitForCardResponse(cardId);

    if (!this.hub.isRunning()) {
      return this.userProvider.promptRetry(errorMessage);
    }
    return answer !== null &&
      answer.toLowerCase() !== 'n' &&
      answer.toLowerCase() !== 'no';
  }
}