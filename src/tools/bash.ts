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
import { retryChat, MODEL } from '../ollama.js';


const OUTPUT_CHAR_LIMIT = 20000;

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: `Run a shell command (blocking). Must specify timeout - process is killed on timeout.`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute. Uses bash on Unix and cmd on Windows. Paths are relative to workspace directory.',
      },
      intent: {
        type: 'string',
        description: 'REQUIRED: Explain why this command is needed. This helps the system understand context and enables smarter output summarization when needed.',
      },
      timeout: {
        type: 'number',
        description: 'REQUIRED: Seconds before killing the process (SIGKILL). Max recommended: 300.',
      },
    },
    required: ['command', 'intent', 'timeout'],
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;
    const intent = args.intent as string;
    const timeoutSeconds = args.timeout as number;

    ctx.core.brief('info', 'bash', command, intent);

    // Check permission (respects plan mode and intent validation)
    const grant = await ctx.core.requestGrant('bash', { command, intent });
    if (!grant.approved) {
      const reason = grant.reason || 'Operation not permitted in current mode';
      ctx.core.brief('error', 'bash', reason);
      return reason;
    }

    // Block direct git commit - must use git_commit tool
    if (/\bgit\s+commit\b/.test(command)) {
      const msg = 'Direct git commit is not allowed. Use the git_commit tool instead.';
      ctx.core.brief('error', 'bash', msg);
      return `Error: ${msg}`;
    }

    let stdout: string, stderr: string, interrupted: boolean, exitCode: number, timedOut: boolean;

    try {
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
      ctx.core.brief('error', 'bash', `Failed to execute command: ${errorMsg}`);
      return `Error: ${errorMsg}`;
    }

    if (timedOut) {
      const msg = `timeout after ${timeoutSeconds} seconds`;
      ctx.core.brief('warn', 'bash', msg);
      return `Error: ${msg}. Use bg_create to run as a service, or set a longer timeout.`;
    }

    if (interrupted) {
      ctx.core.brief('warn', 'bash', 'Command interrupted by user.');
      return 'Command interrupted by user.';
    }

    // Build LLM-friendly output
    const parts: string[] = [];

    // Status line
    if (exitCode === 0) {
      parts.push(`Command completed successfully (exit: ${exitCode})`);
    } else {
      parts.push(`Command failed (exit: ${exitCode})`);
      // Show error to user when command fails
      const errorDetail = stderr.trim() ? `: ${stderr.trim().split('\n')[0].slice(0, 200)}` : '';
      ctx.core.brief('error', 'bash', `Command failed with exit code ${exitCode}${errorDetail}`);
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

    // Check if we need to summarize (by character count, not lines)
    const outputChars = output.length;

    if (outputChars <= OUTPUT_CHAR_LIMIT) {
      return output;
    }

    // Summarize the output
    try {
      const summary = await summarizeOutput(output, intent, outputChars, ctx);
      return summary;
    } catch (err) {
      ctx.core.brief('error', 'bash', `Failed to summarize output: ${(err as Error).message}`);
      // Fall back to raw output instead of crashing
      return `[Summarization failed, showing raw output]\n\n${output}`;
    }
  },
};

/**
 * Summarize command output when it exceeds the character limit
 */
async function summarizeOutput(
  output: string,
  intent: string,
  totalChars: number,
  ctx: AgentContext
): Promise<string> {
  ctx.core.brief('info', 'bash', `Summarizing ${(totalChars / 1000).toFixed(1)}k chars (limit: ${OUTPUT_CHAR_LIMIT / 1000}k)`);

  const response = await retryChat({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `Summarize this command output concisely.
User's intent: ${intent}
Total characters: ${totalChars}
Keep the summary concise and focused on what's relevant to the user's intent.
Report the total character count at the start of your response.`
      },
      { role: 'user', content: output }
    ]
  });

  return `Summary of ${(totalChars / 1000).toFixed(1)}k chars:\n${response.message.content || 'No summary generated'}`;
}

