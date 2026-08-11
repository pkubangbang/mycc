/**
 * console-capture.ts — ConsoleCapture utility for agent-loop tests.
 *
 * Intercepts console.log / console.warn / console.error, collecting output
 * into arrays so tests can assert on what was printed. `stop()` restores the
 * originals fully so there is no leak between tests.
 *
 * Usage:
 *   const cap = new ConsoleCapture();
 *   cap.start();
 *   // ... code under test ...
 *   const { logs, warns, errors } = cap.getOutput();
 *   cap.stop();
 */
export class ConsoleCapture {
  private originals: {
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null = null;

  private logs: string[] = [];
  private warns: string[] = [];
  private errors: string[] = [];

  private active = false;

  /**
   * Replace console.log/warn/error with collectors.
   * Captures any number of arguments, joining them with a space (matching
   * the default console formatting for multiple args).
   */
  start(): void {
    if (this.active) return; // idempotent guard
    this.active = true;
    this.logs = [];
    this.warns = [];
    this.errors = [];

    this.originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };

    console.log = (...args: unknown[]): void => {
      this.logs.push(args.map(String).join(' '));
    };
    console.warn = (...args: unknown[]): void => {
      this.warns.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]): void => {
      this.errors.push(args.map(String).join(' '));
    };
  }

  /**
   * Restore the original console methods. Safe to call multiple times.
   * After stop(), the capture arrays remain accessible via getOutput().
   */
  stop(): void {
    if (!this.active || !this.originals) return;
    console.log = this.originals.log;
    console.warn = this.originals.warn;
    console.error = this.originals.error;
    this.originals = null;
    this.active = false;
  }

  /**
   * Return captured output grouped by channel.
   */
  getOutput(): { logs: string[]; warns: string[]; errors: string[] } {
    return {
      logs: [...this.logs],
      warns: [...this.warns],
      errors: [...this.errors],
    };
  }

  /**
   * Filter captured output across ALL channels (logs + warns + errors),
   * returning only lines that match the given pattern.
   *
   * @param pattern — a plain substring or a RegExp
   * @returns array of matching lines (in collection order: logs, then warns, then errors)
   */
  filter(pattern: string | RegExp): string[] {
    const all = [...this.logs, ...this.warns, ...this.errors];
    const matcher =
      typeof pattern === 'string'
        ? (line: string) => line.includes(pattern)
        : (line: string) => pattern.test(line);
    return all.filter(matcher);
  }
}