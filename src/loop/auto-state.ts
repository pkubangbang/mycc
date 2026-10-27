/**
 * auto-state.ts - Dedicated singleton for autonomous ("auto") mode state
 *
 * Owns the `auto` flag (orthogonal to plan/normal mode), a `streak` counter
 * of consecutive successful LLM stages since the last user input, and the
 * `autoflyThreshold` that powers the "autofly" feature: when auto mode is off
 * but the immutable `--debug-autofly` CLI flag is set and the streak exceeds
 * the threshold (default 3), the PROMPT state handler engages auto mode
 * automatically so the loop keeps running without prompting the user. The
 * engagement decision lives in PROMPT — this singleton only owns the counter
 * and threshold; it never triggers auto mode itself.
 *
 * It also owns `autoCommitBranches` — the LIVE branch allow-list for auto-mode
 * commits. The `--allow-auto-commit` flag only SEEDS that list; the
 * `/auto-commit` slash command then adds to / removes from / clears it. The
 * flag is never mutated, so a `/reload` respawn re-seeds from the original
 * launch value and every session edit is discarded (see
 * `seedAutoCommitBranches()`).
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
 * Default streak threshold for autofly. When auto mode is off, the
 * `--debug-autofly` CLI flag is set, and the streak of consecutive successful
 * LLM stages exceeds this many, the PROMPT state handler engages auto mode
 * automatically.
 */
export const DEFAULT_AUTOfLY_THRESHOLD = 3;

/**
 * Suffix marking an allow-list entry as "also skip the prompt outside auto
 * mode". An entry is therefore `branch` or `branch:autoAdd`.
 */
export const AUTO_ADD_SUFFIX = 'autoAdd';

/** Separator between the branch name and the `autoAdd` suffix. */
export const AUTO_ADD_SEPARATOR = ':';

/**
 * One decoded allow-list entry.
 *
 * WHY THE PROVENANCE TRAVELS INSIDE THE STRING: the CoreModule surface hands
 * the list to the `git_commit` tool as a plain `string[]` — the same shape
 * `/auto-commit` prints. Encoding "this branch was granted with autoAdd" in the
 * entry keeps that surface simple, while `parseAutoCommitEntry()` recovers the
 * two facts the gate needs: which branch, and whether it bypasses the prompt
 * outside auto mode.
 */
export interface AutoCommitEntry {
  /** The git branch short name (exact match, never a glob). */
  branch: string;
  /**
   * true when the entry carries the `autoAdd` suffix: the commit skips the
   * prompt even OUTSIDE auto mode. false for a plain entry, which only applies
   * in auto mode (the pre-`/auto-commit` behavior).
   */
  autoAdd: boolean;
}

/**
 * Decode one allow-list entry (`branch` or `branch:autoAdd`).
 *
 * Tolerant of whitespace around both halves, and treats an unknown suffix as
 * part of the branch name — a branch literally named `x:bogus` must not be
 * silently reinterpreted as a grant.
 */
export function parseAutoCommitEntry(entry: string): AutoCommitEntry {
  const trimmed = entry.trim();
  const sep = trimmed.lastIndexOf(AUTO_ADD_SEPARATOR);
  if (sep > 0 && trimmed.slice(sep + 1).trim() === AUTO_ADD_SUFFIX) {
    return { branch: trimmed.slice(0, sep).trim(), autoAdd: true };
  }
  return { branch: trimmed, autoAdd: false };
}

/**
 * Encode an entry back to its string form.
 */
export function formatAutoCommitEntry(branch: string, autoAdd: boolean): string {
  return autoAdd ? `${branch}${AUTO_ADD_SEPARATOR}${AUTO_ADD_SUFFIX}` : branch;
}

/**
 * The seed value `--allow-auto-commit` contributes at launch.
 *
 * Every launch-granted branch becomes `branch:autoAdd`: skipping the prompt
 * outside auto mode is what the flag always meant, so the seed must not weaken
 * it. Takes the raw flag value as an ARGUMENT rather than importing config.ts,
 * because config.ts is a lower layer and an import edge back to this singleton
 * would create a module cycle.
 *
 * @param rawFlag - the `--allow-auto-commit` value (`'main,dev'`) or undefined
 */
export function autoCommitSeedFromFlag(rawFlag: string | undefined): string[] {
  if (typeof rawFlag !== 'string') return [];
  return rawFlag
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) => formatAutoCommitEntry(b, true));
}

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
   * LIVE branch allow-list for auto-mode commits.
   *
   * Seeds from the `--allow-auto-commit` flag, then `Core` reads and edits it:
   * `/auto-commit on <branches>` adds, `off <branches>` removes, `off --all`
   * clears. The flag itself is never mutated, so `/reload` (a respawn with the
   * original argv) gets the original value back — not the session's edits.
   */
  private autoCommitBranches: string[] = [];

  /**
   * True once the list has been seeded from the launch flag.
   *
   * Seeding is one-shot per process: a second call (re-composition, or a test
   * reusing the singleton) must NOT resurrect branches the user removed with
   * `off --all`.
   */
  private autoCommitSeeded = false;

  /**
   * Callback fired once when the `auto` flag actually flips.
   * Registered by agent-repl to broadcast the change to the webui.
   */
  onAutoChange: OnAutoChangeCallback | null = null;

  /**
   * Seed `autoCommitBranches` from the launch flag — once per process.
   *
   * Called by the lead's composition (agent-repl) with the value of
   * `getAllowAutoCommitBranches()`. Idempotent: subsequent calls are ignored, so
   * the seed cannot undo a session edit.
   *
   * @param branches - launch-granted branch names (bare, without the suffix)
   */
  seedAutoCommitBranches(branches: readonly string[]): void {
    if (this.autoCommitSeeded) return;
    this.autoCommitSeeded = true;
    this.autoCommitBranches = autoCommitSeedFromFlag(branches.join(','));
  }

  /** Whether the launch seed has been applied (diagnostics for /auto-commit). */
  isAutoCommitSeeded(): boolean {
    return this.autoCommitSeeded;
  }

  /**
   * The live allow-list, as encoded entries (`branch` or `branch:autoAdd`).
   *
   * Returns a copy — callers (tools, IPC-shaped mocks) must not mutate the
   * singleton through the returned array.
   */
  getAutoCommitBranches(): string[] {
    return [...this.autoCommitBranches];
  }

  /**
   * Add branches to the allow-list (the `/auto-commit on` path).
   *
   * ADD-ONLY by design: an entry already present is upgraded to `autoAdd` when
   * requested (never downgraded), so `on main:autoAdd` after `on main` widens
   * but `on main` after `on main:autoAdd` cannot silently narrow a grant.
   * Adding a branch does NOT enable auto mode — the gate still requires auto
   * mode for `autoAdd:false` entries.
   *
   * @param branches - branch names to add (parsed via parseAutoCommitEntry)
   * @param autoAdd - when true, every added branch bypasses the prompt outside
   *   auto mode as well
   * @returns the entries that were newly added or upgraded (for reporting)
   */
  addAutoCommitBranches(branches: readonly string[], autoAdd: boolean): AutoCommitEntry[] {
    const changed: AutoCommitEntry[] = [];
    for (const raw of branches) {
      const parsed = parseAutoCommitEntry(raw);
      if (!parsed.branch) continue;
      const wantAutoAdd = autoAdd || parsed.autoAdd;
      const existingIdx = this.autoCommitBranches.findIndex(
        (e) => parseAutoCommitEntry(e).branch === parsed.branch
      );
      if (existingIdx === -1) {
        this.autoCommitBranches.push(formatAutoCommitEntry(parsed.branch, wantAutoAdd));
        changed.push({ branch: parsed.branch, autoAdd: wantAutoAdd });
        continue;
      }
      const existing = parseAutoCommitEntry(this.autoCommitBranches[existingIdx]);
      if (wantAutoAdd && !existing.autoAdd) {
        this.autoCommitBranches[existingIdx] = formatAutoCommitEntry(existing.branch, true);
        changed.push({ branch: existing.branch, autoAdd: true });
      }
    }
    return changed;
  }

  /**
   * Remove branches from the allow-list (the `/auto-commit off <branches>` path).
   *
   * Matches on the BRANCH only — provenance is irrelevant when removing, so
   * `off main` drops `main` whether it was seeded or added by hand.
   *
   * @param branches - branch names to drop
   * @returns the branches actually removed (empty when none matched)
   */
  removeAutoCommitBranches(branches: readonly string[]): string[] {
    const removed: string[] = [];
    for (const raw of branches) {
      const { branch } = parseAutoCommitEntry(raw);
      if (!branch) continue;
      const before = this.autoCommitBranches.length;
      this.autoCommitBranches = this.autoCommitBranches.filter(
        (e) => parseAutoCommitEntry(e).branch !== branch
      );
      if (this.autoCommitBranches.length < before) removed.push(branch);
    }
    return removed;
  }

  /**
   * Clear the whole allow-list (the `/auto-commit off --all` path).
   *
   * Clears launch-seeded entries TOO: the list is the live state and `--all`
   * means "everything", not "everything I added".
   *
   * @returns the entries that were cleared
   */
  clearAutoCommitBranches(): string[] {
    const cleared = [...this.autoCommitBranches];
    this.autoCommitBranches = [];
    return cleared;
  }

  /**
   * The branch list that actually authorizes a commit RIGHT NOW.
   *
   * @param autoMode - whether the lead is currently in auto mode
   * @returns the branch names whose entries apply under the current mode —
   *   `autoAdd` entries always, plain entries only while auto mode is on
   */
  effectiveAutoCommitBranches(autoMode: boolean): string[] {
    const out: string[] = [];
    for (const entry of this.autoCommitBranches) {
      const { branch, autoAdd } = parseAutoCommitEntry(entry);
      if (!branch) continue;
      if (autoAdd || autoMode) out.push(branch);
    }
    return out;
  }

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
   * HOOK). Increments the streak of consecutive successful LLM stages since
   * the last user input.
   *
   * NOTE: This method only increments — it does NOT engage auto mode. The
   * autofly decision (whether to auto-enable auto mode when the streak
   * exceeds a threshold) lives in the PROMPT state handler, gated by the
   * immutable --debug-autofly CLI flag. Keeping the counter pure lets PROMPT
   * own the engagement policy (including the streak > N comparison) in one
   * place, instead of firing mid-LLM-stage.
   */
  recordLlmSuccess(): void {
    this.streak++;
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
