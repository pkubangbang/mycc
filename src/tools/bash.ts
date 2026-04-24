/**
 * bash.ts - Run shell commands with timeout enforcement
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
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
  scope: ['main', 'child', 'bg'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const command = args.command as string;
    const intent = args.intent as string;
    const timeoutSeconds = args.timeout as number;

    // Block dangerous commands
    const dangerous = ['rm -rf /', 'sudo rm', 'mkfs', 'dd if=', '> /dev/sd'];
    if (dangerous.some((d) => command.includes(d))) {
      return 'Error: Dangerous command blocked';
    }

    ctx.core.brief('info', 'bash', command, intent);

    const { stdout, stderr, interrupted, exitCode, timedOut } = await agentIO.exec({
      cwd: ctx.core.getWorkDir(),
      command,
      timeout: timeoutSeconds,
    });

    if (timedOut) {
      return `Error: timeout after ${timeoutSeconds} seconds. Use bg_create to run as a service, or set a longer timeout.`;
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

    // Check if we need to summarize (by character count, not lines)
    const outputChars = output.length;

    if (outputChars <= OUTPUT_CHAR_LIMIT) {
      return output;
    }

    // Summarize the output
    const summary = await summarizeOutput(output, intent, outputChars, ctx);
    return summary;
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