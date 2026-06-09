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
 *
 * Output is automatically summarized if it exceeds 20000 characters.
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';

const OUTPUT_CHAR_LIMIT = 20000;

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: `Run a shell command`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute. Uses bash on Unix and cmd on Windows. Paths are relative to workspace directory.',
      },
      intent: {
        type: 'string',
        description: 'REQUIRED: Explain why this command is needed. You MUST use the intent language to show your idea.',
      },
      timeout: {
        type: 'number',
        description: 'REQUIRED: Seconds before killing the process (SIGKILL). Max: 30.',
        minimum: 1,
        maximum: 30
      },
    },
    required: ['command', 'intent', 'timeout'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;
    const intent = args.intent as string;
    const timeoutSeconds = args.timeout as number;

    // Check permission (respects plan mode and intent validation)
    const grant = await ctx.core.requestGrant('bash', { command, intent });
    if (!grant.approved) {
      const reason = grant.reason || 'Operation not permitted in current mode';
      ctx.core.brief('error', 'bash', `Command is rejected with reason: ${reason}\n\n${command}`, intent);
      return reason;
    }

    // Block direct git commit - must use git_commit tool
    if (/\bgit\s+commit\b/.test(command)) {
      const msg = 'Direct git commit is not allowed. Use the git_commit tool instead.';
      ctx.core.brief('error', 'bash', `Git commit is not allowed.\n\n${command}`, intent);
      return `Error: ${msg}`;
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
      return `Error: ${errorMsg}`;
    }

    if (timedOut) {
      const msg = `Command timeout after ${timeoutSeconds} seconds`;
      ctx.core.brief('warn', 'bash', `${msg}\n\n${command}`);
      return `Error: ${msg}. Use bg_create to run as a service, or set a longer timeout.`;
    }

    if (interrupted) {
      return 'Command interrupted by user.';
    }

    // Build LLM-friendly output
    const parts: string[] = [];

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

    // Verbose output: show the full result contents
    ctx.core.verbose('bash', 'Command output', { command, exitCode, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 500) });

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

