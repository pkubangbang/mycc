/**
 * auto-state.ts - Dedicated singleton for autonomous ("auto") mode state
 *
 * Owns the `auto` flag (orthogonal to plan/normal mode), a `streak` counter
 * of consecutive successful LLM stages since the last user input, and the
 * `autoflyThreshold` that powers the "autofly" feature: when the streak
 * reaches the threshold (default 3), auto mode engages automatically so the
 * loop keeps running without prompting the user.
 *
 * Previously the `auto` flag lived in TWO places kept in lockstep:
 * `agentIO.autoModeFlag` (IO singleton) and `Core.autoFlag` (ctx.core).
 * Both are now thin delegators to this singleton, collapsing every flip site
 * to a single `autoState.setAuto(x)` call and guaranteeing one source of
 * truth.
 *
 * The webui mirror (ServeHub.broadcastAuto) is decoupled via an
 * `onAutoChange` callback registered by agent-repl (where ServeHub is in
 * scope) — this keeps AutoState free of any serve-hub import, avoiding the
 * module-load cycle (agent-io → serve-hub, so serve-hub must not import
 * agent-io or anything that transitively does).
 */

/**
 * Callback fired once when the `auto` flag actually flips (true↔false).
 * Used by agent-repl to broadcast the new state to the webui. Best-effort:
 * errors thrown by the callback are swallowed so a serve-hub issue never
 * blocks the flag transition.
 */
export type OnAutoChangeCallback = (value: boolean) => void;

/**
 * Default streak threshold for autofly. When the streak of consecutive
 * successful LLM stages reaches this many, auto mode engages automatically.
 */
export const DEFAULT_AUTOfLY_THRESHOLD = 3;

/**
 * AutoState - Singleton holding all autonomous-mode state.
 *
 * Lifetime: process-wide. A single shared `autoState` instance is exported;
 * both the lead's AgentIO and Core delegate to it. Child processes (teammates)
 * never touch it — their ChildCore.getAuto() returns false unconditionally.
 */
export class AutoState {
  /** Autonomous mode flag (orthogonal to plan/normal). */
  private auto = false;

  /**
   * Consecutive successful LLM stages since the last user input.
   * Incremented by recordLlmSuccess(); reset to 0 by resetStreak() (on user
   * input) and by setAuto(false) (leaving auto mode shouldn't carry streak).
   */
  private streak = 0;

  /** Streak count at which autofly engages auto mode automatically. */
  private autoflyThreshold: number = DEFAULT_AUTOfLY_THRESHOLD;

  /**
   * Callback fired once when the `auto` flag actually flips.
   * Registered by agent-repl to broadcast the change to the webui.
   */
  onAutoChange: OnAutoChangeCallback | null = null;

  /**
   * Whether the lead is in autonomous (auto) mode. Orthogonal to plan/normal.
   */
  getAuto(): boolean {
    return this.auto;
  }

  /**
   * Enable or disable auto mode.
   *
   * Idempotent: a no-op when the value is unchanged (keeps the redundant
   * re-sync call in prompt.ts's auto-mode safety net from re-broadcasting
   * an 'auto' message). When leaving auto mode (true→false) the streak is
   * reset — a stale streak must not carry over to the next user-driven run.
   * Fires `onAutoChange` once on a real flip (best-effort, errors swallowed).
   *
   * @param value - true to enter auto mode, false to exit
   */
  setAuto(value: boolean): void {
    if (value === this.auto) return;
    this.auto = value;
    if (!value) {
      this.streak = 0;
    }
    if (this.onAutoChange) {
      try {
        this.onAutoChange(value);
      } catch {
        // best-effort: a serve-hub issue must never block the flag transition
      }
    }
  }

  /**
   * Current streak: consecutive successful LLM stages since last user input.
   */
  getStreak(): number {
    return this.streak;
  }

  /**
   * Record a successful LLM stage (called right before the LLM state returns
   * HOOK). Increments the streak, then — if not already in auto mode and the
   * streak has reached the autofly threshold — engages auto mode automatically
   * (the "autofly" feature). Entering auto this way also resets the streak so
   * the next autofly cycle starts from a clean slate.
   */
  recordLlmSuccess(): void {
    this.streak++;
    if (!this.auto && this.streak >= this.autoflyThreshold) {
      this.setAuto(true);
      // setAuto(true) does NOT reset streak; reset explicitly so the next
      // autofly window opens fresh after a user input breaks the cycle.
      this.streak = 0;
    }
  }

  /**
   * Reset the streak to zero. Called whenever real user input arrives
   * (a fresh query, a slash command, or a bang command) — user direction
   * means the prior autonomous streak no longer counts toward autofly.
   */
  resetStreak(): void {
    this.streak = 0;
  }

  /**
   * Current autofly threshold (streak count that triggers auto mode).
   */
  getAutoflyThreshold(): number {
    return this.autoflyThreshold;
  }

  /**
   * Set the autofly threshold (streak count that triggers auto mode).
   * @param value - new threshold (must be a positive integer)
   */
  setAutoflyThreshold(value: number): void {
    this.autoflyThreshold = Math.max(1, Math.floor(value));
  }
}

/**
 * Process-wide singleton. Both AgentIO and Core delegate their getAuto/setAuto
 * to this instance, giving the whole lead process a single source of truth.
 */
export const autoState = new AutoState();