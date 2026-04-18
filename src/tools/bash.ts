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
 *
 * Passthrough mode:
 * - User presses Ctrl+Enter to enter passthrough mode for interactive commands
 * - Output is buffered up to 16KB; when full, shows in real-time
 * - In passthrough mode, raw stdin is forwarded to subprocess
 */

import { execa } from 'execa';
import type { ToolDefinition, AgentContext } from '../types.js';
import { agentIO } from '../loop/agent-io.js';
import { retryChat, MODEL } from '../ollama.js';

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: `Run a shell command (blocking). Must specify timeout - process is killed on timeout. Press Ctrl+Enter during execution for interactive mode.`,
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

    // Clear any previous buffer state
    agentIO.clearBuffers();

    const { result, interrupted } = await agentIO.exec((signal) => {
      const subprocess = execa('bash', ['-c', command], {
        cwd: ctx.core.getWorkDir(),
        stdin: 'pipe',  // Enable stdin for passthrough mode
        stdout: 'pipe',
        stderr: 'pipe',
        encoding: 'utf8',
        cancelSignal: signal,
        gracefulCancel: true,
        reject: false,
        timeout: timeoutSeconds * 1000,
        killSignal: 'SIGKILL',
      });

      // Smart buffering: buffer up to 16KB, then show real-time
      subprocess.stdout?.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (agentIO.isStdoutBufferFull()) {
          // Buffer full, show real-time
          process.stdout.write(buf);
        } else {
          const full = agentIO.addStdoutChunk(buf);
          if (full) {
            // Just became full, flush and continue real-time
            agentIO.flushStdoutBuffer();
          }
        }
      });

      subprocess.stderr?.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (agentIO.isStderrBufferFull()) {
          process.stderr.write(buf);
        } else {
          const full = agentIO.addStderrChunk(buf);
          if (full) {
            agentIO.flushStderrBuffer();
          }
        }
      });

      return subprocess;
    });

    // Handle passthrough mode exit
    if (agentIO.isPassthroughMode()) {
      agentIO.setPassthroughMode(false);
      process.send?.({ type: 'passthrough_ended' });
      agentIO.clearBuffers();
      return 'Interactive session ended.';
    }

    // Flush any remaining buffered output (normal execution)
    agentIO.flushStdoutBuffer();
    agentIO.flushStderrBuffer();
    agentIO.clearBuffers();

    if (interrupted) {
      return 'Command interrupted by user.';
    }

    // Check if command failed
    if (result instanceof Error) {
      if ((result as any).timedOut) {
        return `Error: timeout after ${timeoutSeconds} seconds. Use bg_create to run as a service, or set a longer timeout.`;
      }
      return `Error: ${result.message}`;
    }

    // Build LLM-friendly output
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const exitCode = result.exitCode ?? 0;

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

    // Check if we need to summarize
    const lines = output.split('\n');
    const lineCount = lines.length;

    if (lineCount <= elor) {
      return output;
    }

    // Summarize the output
    const summary = await summarizeOutput(output, intent, elor, lineCount, ctx);
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

  return `Summary of ${totalLines} lines:\n${response.message.content || 'No summary generated'}`;
}