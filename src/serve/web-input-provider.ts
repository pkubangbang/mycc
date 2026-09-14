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
import { ServeDetachedExitError } from './serve-errors.js';
import { shouldDaemon } from '../config.js';

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
      // (2) A restart-webui click transiently has running === false. Keep
      //     waiting: the same hub is coming back on the same port, and
      //     treating the gap as "serve is gone" would kill the daemon.
      if (this.hub.isRestarting()) return this.hub.waitForInput();
      // (1) Headless daemon with serve as the intended input mode — the
      //     terminal fallback can never resolve. Throwing is the only safe
      //     signal: null would be read as "autonomous skip" by prompt.ts and
      //     run a turn with no query. Gated on shouldDaemon() (the --daemon
      //     CLI flag) so a NON-daemon session (plain `mycc`, or `mycc
      //     --serve` in a real terminal) still uses the terminal fallback
      //     even when stdin is not a TTY: the Coordinator proxies key
      //     events via IPC, so UserInputProvider resolves fine without a
      //     real TTY. The old `!process.stdin.isTTY` gate threw in every
      //     non-TTY lead (i.e. ALL leads under the Coordinator, whose stdin
      //     is piped), killing plain `mycc` with "Web UI unavailable and no
      //     terminal".
      if (shouldDaemon()) throw new ServeDetachedExitError();
      // (0) Interactive terminal — today's behaviour, unchanged.
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
    // abortInput() resolved waitForInput() with null — fall back to terminal
    // (with the same three-way guard as getInput's entry: a restart-webui
    // click must keep waiting, and a headless daemon must exit, not hang).
    if (!this.hub.isRunning()) {
      if (this.hub.isRestarting()) return this.hub.waitForInput();
      // Gated on shouldDaemon() — see getInput() entry guard: a non-daemon
      // session must use the terminal fallback even without a real TTY (the
      // Coordinator proxies keys via IPC).
      if (shouldDaemon()) throw new ServeDetachedExitError();
      return this.userProvider.getInput(initialContent);
    }
    return result;
  }

  async promptRetry(errorMessage: string): Promise<boolean> {
    // Auto mode: never block on the user — always retry so autonomous
    // operation continues past transient LLM errors. Applies to both the
    // terminal and serve (card) paths.
    if (agentIO.getAuto()) {
      return true;
    }
    if (!this.hub.isRunning()) {
      // Three-way guard (mirrors getInput): a restart in progress must keep
      // waiting for the hub to come back, and a headless daemon must exit
      // rather than hang on a terminal that does not exist.
      if (this.hub.isRestarting()) {
        // The hub is recycling on the same port — wait for it to come back,
        // then proceed to the card path below. Poll isRunning() by awaiting
        // a fresh input cycle (which resolves once start() flips running back
        // to true and re-arms the input resolver). This is an edge case; the
        // common restart path does not intersect promptRetry.
        await this.hub.waitForInput();
      } else if (shouldDaemon()) {
        // Gated on shouldDaemon() — see getInput() entry guard: a non-daemon
        // session must use the terminal fallback even without a real TTY
        // (the Coordinator proxies keys via IPC).
        throw new ServeDetachedExitError();
      } else {
        return this.userProvider.promptRetry(errorMessage);
      }
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
      // Three-way guard (mirrors getInput): a restart in progress must keep
      // waiting for the same card; a headless daemon must exit, not hang.
      if (this.hub.isRestarting()) {
        // The hub is recycling on the same port — re-await the same card
        // (the resolver survives the restart cycle) and re-evaluate.
        const reAnswer = await this.hub.waitForCardResponse(cardId);
        if (this.hub.isRestarting()) return true; // still cycling — default retry
        // Gated on shouldDaemon() — see getInput() entry guard.
        if (shouldDaemon() && !this.hub.isRunning()) throw new ServeDetachedExitError();
        return reAnswer !== null &&
          reAnswer.toLowerCase() !== 'n' &&
          reAnswer.toLowerCase() !== 'no';
      }
      // Gated on shouldDaemon() — see getInput() entry guard.
      if (shouldDaemon()) throw new ServeDetachedExitError();
      return this.userProvider.promptRetry(errorMessage);
    }
    return answer !== null &&
      answer.toLowerCase() !== 'n' &&
      answer.toLowerCase() !== 'no';
  }
}