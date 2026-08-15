/**
 * bash.ts - Run shell commands with timeout enforcement
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 *
 * Parameters:
 * - command: The shell command to execute
 * - intent: Explain why you want to use this command (mandatory)
 * - timeout: Seconds before killing the process (mandatory)
 *   - Process is killed immediately with SIGKILL on timeout
 * - display: If true, also display stdout to the terminal user via brief,
 *   in addition to returning it as a tool result. Use when the user
 *   explicitly asks to see a command's output (e.g. replaying a crossroad
 *   decision via `mycc-pretty-print --type=crossroad <path>`).
 *
 * Output is automatically summarized if it exceeds 20000 characters.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';

const OUTPUT_CHAR_LIMIT = 20000;
const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Build a pushback warning when the LLM supplied an invalid/missing timeout
 * that had to be coerced. Returns null when the input was already valid
 * (an integer in [1,60]), so no warning is added on correct usage.
 *
 * The warning names exactly what was received and what was used, so the LLM
 * learns the 1-60 integer contract rather than repeating the mistake.
 */
function buildTimeoutWarning(rawTimeout: unknown, usedTimeout: number): string | null {
  // Valid: an integer already in range — no warning.
  if (
    typeof rawTimeout === 'number' &&
    Number.isInteger(rawTimeout) &&
    rawTimeout >= 1 &&
    rawTimeout <= 60
  ) {
    return null;
  }

  // Describe what the LLM sent.
  let receivedDesc: string;
  if (rawTimeout === undefined || rawTimeout === null) {
    receivedDesc = 'no timeout (undefined)';
  } else if (typeof rawTimeout === 'number') {
    receivedDesc = Number.isNaN(rawTimeout)
      ? 'NaN'
      : rawTimeout === Infinity
        ? 'Infinity'
        : rawTimeout === -Infinity
          ? '-Infinity'
          : String(rawTimeout);
  } else {
    receivedDesc = `${typeof rawTimeout} (${JSON.stringify(rawTimeout)})`;
  }

  // Describe why it was rejected and what was used instead.
  let reason: string;
  if (rawTimeout === undefined || rawTimeout === null || (typeof rawTimeout === 'number' && Number.isNaN(rawTimeout))) {
    reason = `timeout is required — using default ${usedTimeout}`;
  } else if (typeof rawTimeout === 'number' && (rawTimeout < 1 || rawTimeout > 60 || !Number.isFinite(rawTimeout))) {
    reason = `out of allowed range [1,60] — clamped to ${usedTimeout}`;
  } else if (typeof rawTimeout === 'number' && !Number.isInteger(rawTimeout)) {
    reason = `not an integer — floored to ${usedTimeout}`;
  } else {
    reason = `invalid type — using default ${usedTimeout}`;
  }

  return `[Warning: bash timeout] Received ${receivedDesc}; ${reason}. Next time, pass an integer timeout between 1 and 60 (e.g. timeout=30).`;
}

/** Prepend the timeout warning (if any) to a result string. */
function withWarning(warning: string | null, body: string): string {
  return warning ? `${warning}\n\n${body}` : body;
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: `Run a command in the platform shell`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute. Uses bash on Unix and powershell on Windows. Paths are relative to workspace directory.',
      },
      intent: {
        type: 'string',
        description: 'REQUIRED: Explain why this command is needed (use intent language).',
      },
      timeout: {
        type: 'number',
        description: 'REQUIRED: Seconds before killing the process (SIGKILL). Integer 1-60. Examples: timeout=10 for a quick read (ls, cat, git status); timeout=30 for builds/tests/install; timeout=60 for long builds. If omitted, defaults to 30.',
        minimum: 1,
        maximum: 60,
        default: 30,
      },
      display: {
        type: 'boolean',
        description: 'If true, also display the command stdout to the terminal user via brief, in addition to returning it as a tool result. Use when the user explicitly asks to see output (e.g. replaying a crossroad decision via `mycc-pretty-print --type=crossroad <path>`). Default: false.',
      },
    },
    required: ['command', 'intent'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;
    const intent = args.intent as string;
    const display = args.display === true;

    // Coerce timeout to a safe integer in [1, 60].
    // The LLM frequently omits timeout (undefined) or sends out-of-range values
    // such as 90/120. agentIO.exec() enforces a strict 1-60 integer invariant
    // and would otherwise throw — so we normalize here at the tool layer.
    const rawTimeout = args.timeout;
    let timeoutSeconds: number;
    if (typeof rawTimeout === 'number' && !Number.isNaN(rawTimeout)) {
      // Floor handles non-integers (5.9 -> 5); clamp handles out-of-range and
      // non-finite (90 -> 60, Infinity -> 60, -Infinity -> 1, 0 -> 1).
      timeoutSeconds = Math.min(60, Math.max(1, Math.floor(rawTimeout)));
    } else {
      // undefined, null, non-number types, or NaN → sane default.
      timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
    }

    // Pushback: if the LLM supplied an invalid/missing timeout, tell it so in
    // the tool result. Silent coercion would hide the mistake and let the LLM
    // keep sending bad values every session. The warning describes what was
    // received vs. what was actually used, so the LLM can self-correct.
    const timeoutWarning = buildTimeoutWarning(rawTimeout, timeoutSeconds);
    if (timeoutWarning) {
      ctx.core.brief('warn', 'bash', timeoutWarning, 'invalid timeout coerced');
    }

    // Check permission (respects plan mode and intent validation)
    const grant = await ctx.core.requestGrant('bash', { command, intent });
    if (!grant.approved) {
      const reason = grant.reason || 'Operation not permitted in current mode';
      ctx.core.brief('error', 'bash', `Command is rejected with reason: ${reason}\n\n${command}`, intent);
      return withWarning(timeoutWarning, reason);
    }

    // Block direct git commit - must use git_commit tool
    if (/\bgit\s+commit\b/.test(command)) {
      const msg = 'Direct git commit is not allowed. Use the git_commit tool instead.';
      ctx.core.brief('error', 'bash', `Git commit is not allowed.\n\n${command}`, intent);
      return withWarning(timeoutWarning, `Error: ${msg}`);
    }

    let stdout: string, stderr: string, interrupted: boolean, exitCode: number, timedOut: boolean;

    try {
      ctx.core.brief('info', 'bash', command, intent);
      const result = await agentIO.exec({
        cwd: ctx.core.getWorkDir(),
        command,
        timeout: timeoutSeconds,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      interrupted = result.interrupted;
      exitCode = result.exitCode;
      timedOut = result.timedOut;
    } catch (err) {
      const errorMsg = (err as Error).message;
      ctx.core.brief('error', 'bash', `Failed to execute command: ${errorMsg}`, 'the last bash call has error');
      return withWarning(timeoutWarning, `Error: ${errorMsg}`);
    }

    if (timedOut) {
      const msg = `Command timeout after ${timeoutSeconds} seconds`;
      ctx.core.brief('warn', 'bash', `${msg}\n\n${command}`);
      return withWarning(timeoutWarning, `Error: ${msg}. Use bg_create to run as a service, or set a longer timeout.`);
    }

    if (interrupted) {
      return withWarning(timeoutWarning, 'Command interrupted by user.');
    }

    // Build LLM-friendly output
    const parts: string[] = [];

    // Pushback warning first, so the LLM sees its timeout mistake up front
    if (timeoutWarning) {
      parts.push(timeoutWarning);
    }

    // Status line
    if (exitCode === 0) {
      parts.push(`Command completed successfully (exit: ${exitCode})`);
    } else {
      parts.push(`Command failed (exit: ${exitCode})`);
    }

    // Output sections with clear labels
    if (stdout.trim()) {
      parts.push(`\n[stdout]\n${stdout.trim()}`);
    }

    if (stderr.trim()) {
      parts.push(`\n[stderr]\n${stderr.trim()}`);
    }

    const output = parts.join('\n');

    // ── display to terminal user ──
    // When display=true, brief the raw stdout to the terminal user so they
    // see the command's output (in addition to the LLM receiving the full
    // structured result below). Only stdout is shown — clean, no labels or
    // exit-code line. This supercedes the old ctx.core.verbose('bash', ...)
    // debug line: display is LLM-controlled and works in any mode, whereas
    // verbose only fired under the -v flag.
    if (display && stdout.trim()) {
      ctx.core.brief('info', 'bash_display', stdout.trim());
    }

    // Check if we need to truncate
    const outputChars = output.length;

    if (outputChars <= OUTPUT_CHAR_LIMIT) {
      return output;
    }

    // Truncate output — show head + tail with a summary line
    const halfLimit = Math.floor(OUTPUT_CHAR_LIMIT / 2);
    const head = output.slice(0, halfLimit);
    const tail = output.slice(outputChars - halfLimit);
    const truncated = `${head}\n\n... [${outputChars - OUTPUT_CHAR_LIMIT} chars truncated] ...\n\n${tail}`;
    return truncated;
  },
};

