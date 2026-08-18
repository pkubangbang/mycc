/**
 * serve-disconnect-timer.ts - 30s disconnect-reconnect timer with suspend detection
 *
 * Extracted from ServeHub. When the last WS client disconnects, a 30s timer
 * starts; if no client reconnects before it fires, the server shuts down.
 *
 * The timer also detects a system suspend/hibernate that froze the process
 * during the wait: during suspend, wall-clock advances but CPU time barely
 * moves. If the timer fired with wall-elapsed exceeding the 30s budget by
 * SUSPEND_EXCESS_MS AND CPU usage is negligible, we treat it as a resume
 * from suspend (NOT a genuine user disconnect) and keep the server alive so
 * the browser can auto-reconnect on resume.
 */
import { agentIO } from '../loop/agent-io.js';

const RECONNECT_TIMEOUT_MS = 30_000;
// Tolerance for detecting a system suspend/hibernate. A normal 30s disconnect
// timer fires within 30s + a few ms of jitter. If the timer fires with
// wall-elapsed exceeding the 30s budget by more than this margin, the process
// was frozen during the wait (suspend/hibernate) — because setTimeout does not
// advance while the process is suspended, the callback simply fires late on
// resume, inflating wall-elapsed by the suspend duration. The CPU check
// (near-zero delta) corroborates that the process was genuinely idle/frozen
// rather than busy.
const SUSPEND_EXCESS_MS = 5_000; // 5s beyond the 30s budget ⇒ suspend

export interface DisconnectTimerCallbacks {
  /** Called when the 30s budget elapses with NO suspend signature (genuine disconnect). */
  onGenuineDisconnect: () => void;
  /**
   * Called when a suspend/resume is detected. The hub drops the dead clients
   * (closeAll) — the timer restarts itself internally so a *genuine* later
   * disconnect still tears down the server.
   */
  onSuspend: () => void;
}

export class DisconnectTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wallBaseline: bigint | null = null;
  private cpuBaseline: { user: number; system: number } | null = null;

  constructor(private readonly cb: DisconnectTimerCallbacks) {}

  /** Start the 30s countdown (no-op if already counting). */
  start(): void {
    if (this.timer) return; // already counting
    // Capture wall-clock + CPU baselines so the timeout handler can detect a
    // system suspend/hibernate that froze this process during the wait.
    this.wallBaseline = process.hrtime.bigint();
    this.cpuBaseline = process.cpuUsage();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onTimeout();
    }, RECONNECT_TIMEOUT_MS);
  }

  /** Cancel any pending countdown (reconnect or stop). */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.wallBaseline = null;
    this.cpuBaseline = null;
  }

  private onTimeout(): void {
    const wallBaseline = this.wallBaseline;
    const cpuBaseline = this.cpuBaseline;
    this.wallBaseline = null;
    this.cpuBaseline = null;

    if (wallBaseline !== null && cpuBaseline !== null) {
      const wallElapsedMs = Number(process.hrtime.bigint() - wallBaseline) / 1e6;
      const cpuElapsed = process.cpuUsage(cpuBaseline);
      const cpuElapsedMs = (cpuElapsed.user + cpuElapsed.system) / 1000; // µs → ms
      const expectedWallMs = RECONNECT_TIMEOUT_MS;
      const excessMs = wallElapsedMs - expectedWallMs;
      // Suspend signature: wall ran far longer than the budget (the timer
      // fired late because the process was frozen), and CPU usage during the
      // whole interval is negligible (process was not actually running).
      if (excessMs > SUSPEND_EXCESS_MS && cpuElapsedMs < 5_000) {
        agentIO.verbose('serve', `suspend/resume detected (wall+${Math.round(excessMs / 1000)}s, cpu ${Math.round(cpuElapsedMs)}ms) — keeping Web UI alive for reconnect`);
        // The existing WS clients are dead from the suspend; drop them so the
        // browser's fresh reconnect is the only one tracked.
        this.cb.onSuspend();
        // Restart the disconnect timer so a *genuine* later disconnect (user
        // actually closes the tab and stays away) still tears down the server.
        this.start();
        return;
      }
    }

    // No client reconnected within 30s — genuine disconnect.
    this.cb.onGenuineDisconnect();
  }
}