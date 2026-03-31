/**
 * teammate-worker.ts - Worker script for child process teammates
 */

import * as readline from 'readline';
import { ollama, MODEL } from '../ollama.js';
import type { Message } from 'ollama';
import type { TeammateStatus } from '../types.js';

// State
let name = '';
let role = '';
let prompt = '';
let status: TeammateStatus = 'idle';
let inbox: Message[] = [];

// System prompt
function buildSystemPrompt(): string {
  return `You are ${name}, a ${role} teammate.

${prompt}

You can use tools to accomplish tasks. When you're done, report your status and enter idle state.
Communicate with other teammates via send_message. Check your inbox with read_inbox.

Current status: ${status}`;
}

// IPC message handler
function handleParentMessage(msg: unknown): void {
  const message = msg as { type: string; [key: string]: unknown };

  switch (message.type) {
    case 'spawn':
      name = message.name as string;
      role = message.role as string;
      prompt = message.prompt as string;
      status = 'working';
      sendToParent({ type: 'status', status: 'working' });
      console.log(`[${name}] Spawned as ${role}`);
      startWork();
      break;

    case 'message':
      inbox.push({
        role: 'user',
        content: `Message from ${message.from}: ${message.title}\n${message.content}`,
      });
      break;

    case 'shutdown':
      sendToParent({ type: 'status', status: 'shutdown' });
      process.exit(0);
      break;
  }
}

// Send message to parent process
function sendToParent(msg: object): void {
  if (process.send) {
    process.send(msg);
  }
}

// Log to parent
function log(message: string): void {
  sendToParent({ type: 'log', message });
}

// Start working on the prompt
async function startWork(): Promise<void> {
  const messages: Message[] = [
    { role: 'user', content: prompt },
  ];

  await agentLoop(messages);
}

// Agent loop for teammate
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    // Check inbox
    if (inbox.length > 0) {
      messages.push(...inbox);
      inbox = [];
    }

    // Build system prompt
    const SYSTEM = buildSystemPrompt();

    // Call LLM
    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      // Note: Tools would need to be loaded dynamically here
      // For now, teammates have limited tool access
    });

    const assistantMessage = response.message;
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantMessage.tool_calls,
    });

    // Log progress
    if (assistantMessage.content) {
      log(assistantMessage.content.slice(0, 100));
    }

    // If no tool calls, we're idle
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      status = 'idle';
      sendToParent({ type: 'status', status: 'idle' });

      // Wait for new messages or timeout
      await waitForMessages(60000);

      if (inbox.length === 0) {
        // Timeout, exit
        sendToParent({ type: 'status', status: 'shutdown' });
        process.exit(0);
      }

      status = 'working';
      sendToParent({ type: 'status', status: 'working' });
      continue;
    }

    // Execute tool calls (simplified - would need tool loader)
    for (const toolCall of assistantMessage.tool_calls || []) {
      const toolName = toolCall.function.name;
      log(`Tool: ${toolName}`);
      // Tool execution would go here
      messages.push({
        role: 'tool',
        content: `Tool ${toolName} executed. (Implement tool execution)`,
      });
    }
  }
}

// Wait for new messages
async function waitForMessages(timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (inbox.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Handle IPC messages from parent
process.on('message', (msg: unknown) => {
  handleParentMessage(msg);
});

// Handle stdin for debugging
if (process.stdin.isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('line', (line) => {
    inbox.push({ role: 'user', content: line });
  });
}

// Keep process alive
process.stdin.resume();