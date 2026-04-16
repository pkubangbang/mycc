/**
 * read-read.ts - Summarize long content using two-turn rolling summary
 *
 * Scope: ['main', 'child'] - Not available to bg agents
 */

import * as fs from 'fs';
import type { ToolDefinition, AgentContext } from '../types.js';
import { retryChat, MODEL } from '../ollama.js';
import { getTokenThreshold } from '../config.js';

export const readReadTool: ToolDefinition = {
  name: 'read_read',
  description: 'Summarize long content from .mycc/longtext/ files. Use when tool results are too large for context. Requires file path and focus topic.',
  input_schema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Path to file in .mycc/longtext/ to summarize'
      },
      focus: {
        type: 'string',
        description: 'What to focus on during summarization'
      }
    },
    required: ['file', 'focus']
  },
  scope: ['main', 'child'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const filePath = args.file as string;
    const focus = args.focus as string;

    ctx.core.brief('info', 'read_read', filePath);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const TOKEN_THRESHOLD = getTokenThreshold();

      // Two-turn rolling summary implementation
      const summary = await twoTurnSummary(content, focus, TOKEN_THRESHOLD, ctx);
      return summary;
    } catch (error: unknown) {
      return `Error: ${(error as Error).message}`;
    }
  }
};

async function twoTurnSummary(content: string, focus: string, TOKEN_THRESHOLD: number, ctx: AgentContext): Promise<string> {
  const contentLength = content.length;

  // Find N: smallest positive integer where (contentLength / N) < 60% of TOKEN_THRESHOLD
  const maxChunkSize = Math.floor(0.6 * TOKEN_THRESHOLD);
  const N = Math.ceil(contentLength / maxChunkSize);

  ctx.core.brief('info', 'read_read', `split into ${N} chunks, focus: ${focus}`);

  // Split content into N equal-sized consecutive chunks
  const chunkSize = Math.ceil(contentLength / N);
  const chunks: string[] = [];
  for (let i = 0; i < contentLength; i += chunkSize) {
    chunks.push(content.slice(i, Math.min(i + chunkSize, contentLength)));
  }

  const systemPrompt1 = `You are summarizing content. Be concise but preserve critical details. Focus on: ${focus}.`;
  const systemPrompt2 = `You are refining a summary. A total of ${N} chunks will be given to you, one chunk at a time. Focus on: ${focus}. Catch anything that is missing.`

  let buffer: string = '';

  // First turn
  for (let i = 0; i < chunks.length; i++) {
    const messages = [
      { role: 'system', content: systemPrompt1 },
      { role: 'user', content: i === 0
        ? chunks[0]
        : `Previous summary:\n${buffer}\n\nNext chunk:\n${chunks[i]}`
      }
    ];

    const response = await retryChat({ model: MODEL, messages: messages as any });
    buffer = response.message.content || '';
  }

  // Second turn
  for (let i = 0; i < chunks.length; i++) {
    const messages = [
      { role: 'system', content: systemPrompt2 },
      { role: 'user', content: `Previous summary:\n${buffer}\n\nCurrent chunk:\n${chunks[i]}`}
    ];

    const response = await retryChat({ model: MODEL, messages: messages as any });
    buffer = response.message.content || '';
  }

  return buffer;
}