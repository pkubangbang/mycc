/**
 * verbose-log.ts - Tee console output to a timestamped log file when -v is set
 *
 * When verbose mode is enabled, this module tees everything written to
 * stdout/stderr (via console.log/console.error and direct
 * process.stdout/stderr writes) into a file at
 *   .mycc/verbose-<role>-<timestamp>.log
 *
 * The tee is installed ONCE per process. Subsequent calls are no-ops (the
 * log fd is already open). This is used by both the Coordinator (index.ts)
 * and the Lead (lead.ts) so their output is captured even when the process
 * has no controlling terminal (e.g. `--daemon`, where OS stdio is 'ignore'
 * and the terminal shows nothing).
 *
 * SYNCHRONOUS WRITES (why not fs.createWriteStream):
 * A WriteStream buffers asynchronously, so bytes handed to `stream.write()`
 * in the last few microseconds of a process are still in the internal buffer
 * when `process.exit()` runs — and `process.exit` does NOT flush pending
 * stream writes, it discards them. The daemon's most valuable line is exactly
 * such a last-microsecond write: a fatal startup error (e.g. "Skill 'x' not
 * found. Cannot start daemon.") written immediately before `process.exit(1)`.
 * With a WriteStream that line silently vanished from the log, making a
 * hard crash look like a silent exit with no trace. Writing SYNCHRONOUSLY
 * (fs.writeSync on an open fd) makes every byte durable at the moment it is
 * produced, so the fatal tail survives the abrupt exit. The cost — a blocking
 * write per line — is irrelevant here: this path is debug-only (gated on -v)
 * and produces human-scale volume.
 *
 * Note: We intercept the low-level `process.stdout.write` / `process.stderr.write`
 * rather than patching `console.*`, because the Lead forwards child stdout
 * directly via `process.stdout.write(chunk)` — patching console alone would
 * miss those bytes.
 */

import * as fs from 'fs';
import * as path from 'path';

let installed = false;

/**
 * Install a verbose log tee for the current process.
 *
 * @param role - 'coordinator' or 'lead' (used in the filename)
 * @returns the absolute path of the log file, or null if verbose is off /
 *          tee already installed / .mycc could not be created.
 */
export function installVerboseLog(role: 'coordinator' | 'lead'): string | null {
  if (installed) return null;

  const dotMycc = path.join(process.cwd(), '.mycc');
  try {
    if (!fs.existsSync(dotMycc)) {
      fs.mkdirSync(dotMycc, { recursive: true });
    }
  } catch {
    return null;
  }

  const ts = Math.floor(Date.now() / 1000);
  const logPath = path.join(dotMycc, `verbose-${role}-${ts}.log`);

  // Open the log fd once. A raw fd + fs.writeSync gives us synchronous,
  // crash-durable writes (see the file header for why a WriteStream loses the
  // fatal tail). O_APPEND so concurrent appends from the same role never
  // clobber each other; the file is per-PID-unique by timestamp anyway.
  let fd: number;
  try {
    fd = fs.openSync(logPath, 'a');
  } catch {
    return null;
  }

  // Mark installed only AFTER the fd is open. (The earlier placement, right
  // after the `if (installed) return null` guard, left `installed` true on the
  // `.mycc` creation / open early-return paths, so a later retry no-oped and
  // verbose logging stayed disabled for the whole process with no log file —
  // a permanent silent failure.)
  installed = true;

  // Capture the ORIGINAL (unwrapped) stderr writer before defining writeChunk.
  // writeChunk's one-time failure warning must write to the real stderr, not
  // the tee wrapper we install below — otherwise the warning would be fed
  // right back into the broken fd and be swallowed.
  const realStderrWrite = process.stderr.write.bind(process.stderr) as
    (chunk: string | Uint8Array, cb?: (err?: Error | null) => void) => boolean;

  let verboseWriteFailed = false;

  /**
   * Append a chunk to the log synchronously. Serializes to a string/Buffer and
   * fs.writeSync's it to the fd — durable before returning, so a fatal line
   * written just before process.exit survives. Failures warn ONCE to the real
   * stderr and latch `verboseWriteFailed` so later writes short-circuit
   * (avoids per-line error spam on a full disk / revoked permission).
   */
  const writeChunk = (chunk: unknown): void => {
    if (verboseWriteFailed) return;
    try {
      // Normalize to a string so the string overload of fs.writeSync is
      // unambiguously selected (the Buffer/ArrayBufferView overload cannot
      // accept a plain string, and TS rejects the union). Decoding a Buffer
      // to utf-8 is lossless for the log's text content.
      const data =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf-8')
            : String(chunk);
      fs.writeSync(fd, data);
    } catch (err) {
      // Don't crash the process, but warn ONCE so disk-full / permission /
      // closed-fd errors are not silently lost.
      verboseWriteFailed = true;
      try {
        realStderrWrite(`[verbose-log] Write to ${logPath} failed, logging disabled: ${err instanceof Error ? err.message : String(err)}\n`);
      } catch {
        // last-resort: even the warning failed; nothing more we can do
      }
    }
  };

  // Intercept stdout. We wrap process.stdout.write so every byte written
  // (console.log, console.error, direct process.stdout.write) is mirrored
  // to the log file before reaching the real stream.
  const origStdoutWrite = process.stdout.write.bind(process.stdout) as
    (chunk: string | Uint8Array, cb?: (err?: Error | null) => void) => boolean;
  (process.stdout.write as typeof process.stdout.write) = ((chunk: unknown, ...rest: unknown[]) => {
    writeChunk(chunk);
    return origStdoutWrite(chunk as string | Uint8Array, rest[0] as ((err?: Error | null) => void) | undefined);
  }) as typeof process.stdout.write;

  // Intercept stderr
  const origStderrWrite = process.stderr.write.bind(process.stderr) as
    (chunk: string | Uint8Array, cb?: (err?: Error | null) => void) => boolean;
  (process.stderr.write as typeof process.stderr.write) = ((chunk: unknown, ...rest: unknown[]) => {
    writeChunk(chunk);
    return origStderrWrite(chunk as string | Uint8Array, rest[0] as ((err?: Error | null) => void) | undefined);
  }) as typeof process.stderr.write;

  // Also capture uncaught errors so a silent crash leaves a trace in the log.
  // Synchronous writes make these durable even when the crash is followed by
  // an immediate process.exit.
  process.on('uncaughtException', (err) => {
    writeChunk(`\n[uncaughtException] ${err.stack || err.message || String(err)}\n`);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    writeChunk(`\n[unhandledRejection] ${msg}\n`);
  });

  // Close the fd on normal process exit (defensive; writes are already sync,
  // so there is nothing buffered to flush — this only releases the handle).
  process.on('exit', () => {
    try {
      fs.closeSync(fd);
    } catch {
      // best-effort; the OS reclaims the fd regardless
    }
  });

  // Header line so the file is never empty / easy to identify.
  writeChunk(`=== ${role} verbose log (pid=${process.pid}) started at ${new Date().toISOString()} ===\n`);

  return logPath;
}
