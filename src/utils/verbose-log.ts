/**
 * verbose-log.ts - Tee console output to a timestamped log file when -v is set
 *
 * When verbose mode is enabled, this module installs a write stream that
 * mirrors everything written to stdout/stderr (via console.log/console.error
 * and direct process.stdout/stderr writes) into a file at
 *   .mycc/verbose-<role>-<timestamp>.log
 *
 * The tee is installed ONCE per process. Subsequent calls are no-ops (the
 * stream is already open). This is used by both the Coordinator (index.ts)
 * and the Lead (lead.ts) so their output is captured even when the process
 * has no controlling terminal (e.g. `--daemon`).
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
  installed = true;

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

  let stream: fs.WriteStream;
  try {
    stream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch {
    return null;
  }

  // Capture the ORIGINAL (unwrapped) stderr writer before defining writeChunk.
  // writeChunk's one-time failure warning must write to the real stderr, not
  // the tee wrapper we install below — otherwise the warning would be fed
  // right back into the broken stream and be swallowed.
  const realStderrWrite = process.stderr.write.bind(process.stderr) as
    (chunk: string | Uint8Array, cb?: (err?: Error | null) => void) => boolean;

  let verboseWriteFailed = false;

  // An async write failure on the stream (ENOSPC, permission revoked, the
  // log volume being unmounted mid-run) emits an 'error' event. WITHOUT a
  // listener, Node escalates an unhandled stream 'error' to an
  // uncaughtException — and the uncaughtException handler below writes back
  // to this SAME broken stream, which fails again and emits another 'error',
  // producing a feedback loop of uncaughtException spam (one per stdout
  // write) that can mask the real error. Attach an 'error' listener that
  // mirrors the synchronous writeChunk path's discipline: warn ONCE to the
  // real stderr and set the shared verboseWriteFailed flag so every later
  // write attempt short-circuits, breaking the loop. (Attached here, after
  // the flag/realStderrWrite are declared, so the closure sees them at
  // attach time with no temporal-dead-zone ambiguity.)
  stream.on('error', (err) => {
    if (!verboseWriteFailed) {
      verboseWriteFailed = true;
      try {
        realStderrWrite(`[verbose-log] Log stream error on ${logPath}, logging disabled: ${err instanceof Error ? err.message : String(err)}\n`);
      } catch {
        // last-resort: even the warning failed; nothing more we can do
      }
    }
  });

  const writeChunk = (chunk: unknown): boolean => {
    try {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        stream.write(chunk);
      } else {
        stream.write(String(chunk));
      }
    } catch (err) {
      // Don't crash the process, but warn ONCE so disk-full / permission /
      // stream-closed errors are not silently lost — without this, every
      // subsequent verbose log line is dropped with zero diagnostic. The
      // warning goes to the real stderr (captured above), not the tee.
      if (!verboseWriteFailed) {
        verboseWriteFailed = true;
        try {
          realStderrWrite(`[verbose-log] Write to ${logPath} failed, logging disabled: ${err instanceof Error ? err.message : String(err)}\n`);
        } catch {
          // last-resort: even the warning failed; nothing more we can do
        }
      }
    }
    return true;
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
  process.on('uncaughtException', (err) => {
    try {
      stream.write(`\n[uncaughtException] ${err.stack || err.message || String(err)}\n`);
    } catch { /* ignore */ }
  });
  process.on('unhandledRejection', (reason) => {
    try {
      const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
      stream.write(`\n[unhandledRejection] ${msg}\n`);
    } catch { /* ignore */ }
  });

  // Header line so the file is never empty / easy to identify.
  stream.write(`=== ${role} verbose log (pid=${process.pid}) started at ${new Date().toISOString()} ===\n`);

  return logPath;
}