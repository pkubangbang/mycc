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
import { getSteeringManager } from '../loop/steering-manager.js';
import { tryGetServeHub, type ServeHubLike } from './serve-registry.js';
import { agentIO } from '../loop/agent-io.js';
import { tryDisplayWrapUp } from '../loop/esc-wrap-up.js';
import { ServeDetachedExitError } from './serve-errors.js';
import { shouldDaemon } from '../config.js';

export class WebInputProvider implements InputProvider {
  readonly name = 'web';
  private userProvider: UserInputProvider; // CLI fallback when serve not running

  /**
   * The hub is resolved LAZILY on every access, never cached, because in
   * `--serve` mode `activateServe()` materializes the hub AFTER this provider
   * is constructed — a cached null would break serve mode. In a plain terminal
   * boot the hub is never loaded at all, so `tryGetServeHub()` returns null and
   * every access degrades to the terminal fallback (see `liveHub()`).
   *
   * The ctor no longer takes a hub: taking the instance would force every
   * caller to resolve one at construction, which is precisely the boot-path
   * throw the lazy registry exists to avoid.
   *
   * Captured-reference validity across awaits: getInput()/promptRetry()
   * capture `const hub = this.liveHub()` ONCE and reuse it after an await.
   * That is safe because ServeHub.getInstance() returns a process-lifetime
   * static singleton and restartServe() recycles the stack on the SAME
   * instance (stop(true) → start() on `this`), so the reference never points
   * at a torn-down object. If restart semantics ever change to constructing a
   * FRESH hub, the capture must become a re-resolution after each await.
   */
  constructor(userProvider: UserInputProvider) {
    this.userProvider = userProvider;
  }

  /**
   * The ServeHub when the serve layer has been loaded, else null. A null hub
   * is treated exactly like "serve not running" everywhere below: the terminal
   * fallback owns input. Never throws, never forces a module load.
   */
  private liveHub(): ServeHubLike | null {
    return tryGetServeHub();
  }

  async getInput(initialContent?: string): Promise<string | null> {
    const hub = this.liveHub();
    if (!hub || !hub.isRunning()) {
      // (2) A restart-webui click transiently has running === false. Keep
      //     waiting: the same hub is coming back on the same port, and
      //     treating the gap as "serve is gone" would kill the daemon.
      if (hub && hub.isRestarting()) return hub.waitForInput();
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
      // (0) Interactive terminal — today's behaviour, unchanged. Terminal
      // fallback site for the A2 wipe (plan §5): belt-and-suspenders — stop()
      // already cleared the queue on every currently-reachable path here —
      // but the fallback owns terminal-teardown symmetry with the post-abort
      // branch below. The restart branch above returns BEFORE this line, so
      // a 重启 cycle never wipes held notes.
      getSteeringManager().clear();
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
    hub.broadcast('prompt', initialContent || '');
    // Belt-and-suspenders: surface any wrap-up that completed BEFORE this
    // prompt reappeared (the robust completion trigger in esc-wrap-up.ts
    // startWrapUp already delivered it via displayLetterBox the moment the
    // background LLM finished; this catches the race where the wrap-up
    // finished in the small window before the serve prompt broadcast). Null
    // editor = serve mode (no LineEditor). markWrapUpShown makes this a no-op
    // if the completion trigger already ran, so double-display is impossible.
    tryDisplayWrapUp(null);
    const result = await hub.waitForInput();

    // After await, check if serve was stopped during the wait.
    // abortInput() resolved waitForInput() with null — fall back to terminal
    // (with the same three-way guard as getInput's entry: a restart-webui
    // click must keep waiting, and a headless daemon must exit, not hang).
    if (!hub.isRunning()) {
      if (hub.isRestarting()) return hub.waitForInput();
      // Gated on shouldDaemon() — see getInput() entry guard: a non-daemon
      // session must use the terminal fallback even without a real TTY (the
      // Coordinator proxies keys via IPC).
      if (shouldDaemon()) throw new ServeDetachedExitError();
      // Terminal fallback = the WAIT IS OVER for good: any steering note
      // still held (e.g. behind a wrap-up window that will never wake into
      // a live hub) must not linger — wipe the queue (A2, plan §5), mirroring
      // stop()'s terminal-teardown wipe. The manager is loop-homed; reaching
      // here means this hub will never deliver to the webui again.
      getSteeringManager().clear();
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
    const hub = this.liveHub();
    if (!hub || !hub.isRunning()) {
      // Three-way guard (mirrors getInput): a restart in progress must keep
      // waiting for the hub to come back, and a headless daemon must exit
      // rather than hang on a terminal that does not exist.
      if (hub && hub.isRestarting()) {
        // The hub is recycling on the same port — wait for it to come back,
        // then proceed to the card path below. Poll isRunning() by awaiting
        // a fresh input cycle (which resolves once start() flips running back
        // to true and re-arms the input resolver). This is an edge case; the
        // common restart path does not intersect promptRetry.
        await hub.waitForInput();
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
    hub.broadcast('error', `Error: ${errorMessage}`);

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
    hub.broadcastCard({
      type: 'card',
      cardId,
      query: 'Retry?',
      kind: 'confirm',
      options: [
        { label: 'Yes', value: 'y' },
        { label: 'No', value: 'n' },
      ],
    });
    const answer = await hub.waitForCardResponse(cardId);

    if (!hub.isRunning()) {
      // Three-way guard (mirrors getInput): a restart in progress must keep
      // waiting for the same card; a headless daemon must exit, not hang.
      if (hub.isRestarting()) {
        // The hub is recycling on the same port — re-await the same card
        // (the resolver survives the restart cycle) and re-evaluate.
        const reAnswer = await hub.waitForCardResponse(cardId);
        if (hub.isRestarting()) return true; // still cycling — default retry
        // Gated on shouldDaemon() — see getInput() entry guard.
        if (shouldDaemon() && !hub.isRunning()) throw new ServeDetachedExitError();
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