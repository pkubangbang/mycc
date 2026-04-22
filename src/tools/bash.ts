/**
 * bash.ts - Run shell commands with timeout enforcement
 *
 * Scope: ['main', 'child', 'bg'] - Available to all agent types
 *
 * Parameters:
 * - command: The shell command to execute
 * - intent: Explain why you want to use this command (mandatory)
 * - elor: Expected line of result (default: 50)
 * - timeout: Seconds before killing the process (mandatory)
 *   - Process is killed immediately with SIGKILL on timeout
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';
import { retryChat, MODEL } from '../ollama.js';

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: `Run a shell command (blocking). Must specify timeout - process is killed on timeout.`,
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute. Must be valid bash syntax. Paths are relative to workspace directory.',
      },
      intent: {
        type: 'string',
        description: 'REQUIRED: Explain why this command is needed. This helps the system understand context and enables smarter output summarization when needed.',
      },
      elor: {
        type: 'number',
        description: 'Expected Lines Of Result (default: 50). Output exceeding this limit is summarized. Set higher (100-500) for detailed output like logs or large file listings. Values below 10 are discouraged as they force excessive summarization.',
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
    const elor = (args.elor as number) ?? 50;
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

    // Check if we need to summarize
    // Count only the stdout lines, not the status/metadata lines
    const stdoutLines = stdout.trim() ? stdout.trim().split('\n').length : 0;
    const stderrLines = stderr.trim() ? stderr.trim().split('\n').length : 0;
    const outputLines = stdoutLines + stderrLines;

    if (outputLines <= elor) {
      return output;
    }

    // Summarize the output
    const summary = await summarizeOutput(output, intent, elor, outputLines, ctx);
    return summary;
  },
};

/**
 * Summarize command output when it exceeds the expected line count
 */
async function summarizeOutput(
  output: string,
  intent: string,
  elor: number,
  totalLines: number,
  ctx: AgentContext
): Promise<string> {
  ctx.core.brief('info', 'bash', `Summarizing ${totalLines} lines (elor: ${elor})`);

  const response = await retryChat({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `Summarize this command output concisely.
User's intent: ${intent}
Total lines: ${totalLines}
Keep the summary under ${elor} lines.
Report the total line count at the start of your response.`
      },
      { role: 'user', content: output }
    ]
  });

  return `Summary of ${totalLines} lines (set a larger "elor" to see full content):\n${response.message.content || 'No summary generated'}`;
}