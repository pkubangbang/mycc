/**
 * trialogue.ts - Message management with auto-compact and role validation
 *
 * Trialogue manages the conversation history (messages) with:
 * - Automatic compaction when token threshold exceeded
 * - Role transition validation (detect misordered messages)
 * - Bridge response generation for gaps
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { retryChat, MODEL } from '../ollama.js';
import type { Message, ToolCall } from '../types.js';
import { getMyccDir, ensureDirs } from '../context/db.js';
import { ConfusionCalculator } from './confusion-calculator.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface MisorderWarning {
  from: Role;
  to: Role;
  gap: 'missing_assistant' | 'missing_tool_response' | 'unexpected_duplicate' | 'invalid_sequence';
  context: { lastMessage?: Message; newMessage?: Partial<Message> };
}

export interface ToolAlignmentWarning {
  functionName: string;
  toolCallId?: string;
  issue: 'no_pending_calls' | 'id_not_found' | 'name_mismatch' | 'orphan_result';
  expectedId?: string;
  expectedName?: string;
}

export interface TrialogueOptions {
  /** Token threshold for auto-compact (default: 50000) */
  tokenThreshold?: number;
  /** Message threshold for hint round (default: 10) */
  hintThreshold?: number;
  /** Called when misordered role transition detected */
  onMisorder?: (warning: MisorderWarning) => void;
  /** Called when tool call/result alignment issue detected */
  onToolMisalign?: (warning: ToolAlignmentWarning) => void;
  /** Called when auto-compact is triggered */
  onCompact?: (transcriptPath: string) => void;
  /** Called after each message is added */
  onMessage?: (messages: Message[]) => void;
  /** Called when hint round is generated */
  onHint?: () => void;
}

export class Trialogue {
  private messages: Message[] = [];
  private pendingToolCalls: Map<string, ToolCall> = new Map();
  private pendingToolCallOrder: string[] = []; // Track order for sequential resolution
  private tokenCount: number = 0;
  private systemPrompt: string | null = null;
  private confusion: ConfusionCalculator;
  private hintGenerated: boolean = false;
  private options: Required<TrialogueOptions>;

  constructor(options: TrialogueOptions = {}) {
    const hintThreshold = options.hintThreshold ?? 10;
    this.confusion = new ConfusionCalculator(hintThreshold);
    this.options = {
      tokenThreshold: options.tokenThreshold ?? 50000,
      hintThreshold: hintThreshold,
      onMisorder: options.onMisorder ?? this.defaultOnMisorder,
      onToolMisalign: options.onToolMisalign ?? this.defaultOnToolMisalign,
      onCompact: options.onCompact ?? this.defaultOnCompact,
      onMessage: options.onMessage ?? (() => {}),
      onHint: options.onHint ?? (() => {}),
    };
  }

  // === Core API ===

  /**
   * Set or update the system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Add a user message
   */
  user(content: string): void {
    // Run microCompact if transitioning from tool role
    if (this.getLastRole() === 'tool') {
      this.runMicroCompact();
    }
    this.addMessage({ role: 'user', content });
  }

  /**
   * Add a tool response message
   * @param functionName - The name of the tool that was called (becomes tool_name)
   * @param result - The result/output from the tool call (becomes content)
   * @param toolCallId - Optional ID from model's tool_calls (resolved from pending if not provided)
   */
  tool(functionName: string, result: string, toolCallId?: string): void {
    // Check for missing assistant with tool_calls
    const lastRole = this.getLastRole();
    if (lastRole !== 'assistant' && lastRole !== 'tool') {
      this.handleMisorder('tool', { content: result, tool_name: functionName, tool_call_id: toolCallId });
      return;
    }

    // Resolve toolCallId if not provided
    let resolvedId = toolCallId;
    if (!resolvedId) {
      // Find the next pending tool call matching this function name
      resolvedId = this.findPendingToolCall(functionName);
    }

    // Validate alignment
    this.validateToolAlignment(functionName, resolvedId);

    // Add the tool response with both tool_name and tool_call_id
    this.addMessage({
      role: 'tool',
      tool_name: functionName,
      content: result,
      tool_call_id: resolvedId,
    });

    // Remove from pending after adding result
    if (resolvedId && this.pendingToolCalls.has(resolvedId)) {
      this.pendingToolCalls.delete(resolvedId);
      this.pendingToolCallOrder = this.pendingToolCallOrder.filter(id => id !== resolvedId);
    }
  }

  /**
   * Find pending tool call by function name (returns first match in order)
   */
  private findPendingToolCall(functionName: string): string | undefined {
    for (const id of this.pendingToolCallOrder) {
      const tc = this.pendingToolCalls.get(id);
      if (tc && tc.function.name === functionName) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Validate tool call/result alignment
   */
  private validateToolAlignment(functionName: string, toolCallId?: string): void {
    // No pending tool calls at all - orphan result
    if (this.pendingToolCalls.size === 0) {
      this.options.onToolMisalign({
        functionName,
        toolCallId,
        issue: 'no_pending_calls',
      });
      return;
    }

    // toolCallId provided but not found in pending
    if (toolCallId && !this.pendingToolCalls.has(toolCallId)) {
      this.options.onToolMisalign({
        functionName,
        toolCallId,
        issue: 'id_not_found',
      });
      return;
    }

    // toolCallId provided but name mismatch
    if (toolCallId) {
      const tc = this.pendingToolCalls.get(toolCallId);
      if (tc && tc.function.name !== functionName) {
        this.options.onToolMisalign({
          functionName,
          toolCallId,
          issue: 'name_mismatch',
          expectedName: tc.function.name,
        });
      }
    }
  }

  /**
   * Add an assistant message
   */
  agent(content: string, toolCalls?: ToolCall[]): void {
    const lastRole = this.getLastRole();

    // Check for unexpected duplicate assistant
    if (lastRole === 'assistant') {
      this.handleMisorder('assistant', { content, tool_calls: toolCalls });
      return;
    }

    this.addMessage({
      role: 'assistant',
      content: content || '',
      tool_calls: toolCalls,
    });

    // Track pending tool calls in order
    if (toolCalls) {
      for (const tc of toolCalls) {
        this.pendingToolCalls.set(tc.id, tc);
        this.pendingToolCallOrder.push(tc.id);
      }
    }
  }

  /**
   * Force auto-compact now
   */
  async compact(): Promise<void> {
    const compacted = await this.runAutoCompact();
    this.messages = compacted;
    this.tokenCount = this.estimateTokens(this.messages);
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
    // Reset hint flag after compact since conversation is reset
    this.resetHint();
  }

  /**
   * Check if a hint round is needed
   * Returns true if confusion threshold reached and no hint generated yet
   */
  needsHintRound(): boolean {
    if (this.hintGenerated) return false;
    if (!this.confusion.needsHint()) return false;
    // Only generate hint after a valid transition point (assistant or tool message)
    const lastRole = this.getLastRole();
    return lastRole === 'assistant' || lastRole === 'tool';
  }

  /**
   * Called after tool execution - updates confusion score
   */
  onToolResult(toolName: string, args: Record<string, unknown> | undefined, result: string): void {
    this.confusion.onToolCall(toolName, args);
    if (result.startsWith('Error:')) {
      this.confusion.onError();
    }
  }

  /**
   * Reset hint flag (call on new user query)
   */
  resetHint(): void {
    this.hintGenerated = false;
    this.confusion.reset();
  }

  /**
   * Generate a hint round with problem analysis
   * Adds user message with analysis and gets assistant acknowledgment
   */
  async generateHintRound(): Promise<void> {
    if (this.hintGenerated) return;

    // Build analysis prompt from conversation
    const conversationText = this.messages
      .map((m) => `[${m.role}]: ${m.content || '(tool call)'}`)
      .join('\n\n');

    const analysisPrompt = `Analyze this conversation for potential issues and blockers:

${conversationText}

Identify:
1. Any problems or blockers encountered (errors, failed attempts, stuck patterns)
2. Patterns that might indicate getting stuck (repeated actions, circular reasoning)
3. Suggest concrete workarounds or alternative approaches

Be specific and actionable. This analysis will help guide the next steps.`;

    // Get analysis from LLM
    const response = await retryChat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: analysisPrompt,
        },
      ],
    });

    const analysis = response.message.content || '(no analysis)';

    // Add user message with hint
    this.messages.push({
      role: 'user',
      content: `[HINT] ${analysis}`,
    });

    // Get assistant acknowledgment
    const ackResponse = await retryChat({
      model: MODEL,
      messages: this.getMessages(),
    });

    const acknowledgment = ackResponse.message.content || 'Understood. I will consider this analysis.';

    this.messages.push({
      role: 'assistant',
      content: acknowledgment,
    });

    // Update token count for new messages
    for (const msg of this.messages.slice(-2)) {
      this.updateTokenCount(msg);
    }

    this.hintGenerated = true;
    this.options.onHint();
  }

  // === Accessors ===

  /**
   * Get messages with system prompt prepended if set
   */
  getMessages(): Message[] {
    if (this.systemPrompt) {
      return [{ role: 'system', content: this.systemPrompt }, ...this.messages];
    }
    return [...this.messages];
  }

  /**
   * Get messages without system prompt
   */
  getMessagesRaw(): Message[] {
    return [...this.messages];
  }

  /**
   * Get current token count
   */
  getTokenCount(): number {
    return this.tokenCount;
  }

  /**
   * Get last message role, or null if empty
   */
  getLastRole(): Role | null {
    if (this.messages.length === 0) return null;
    return this.messages[this.messages.length - 1].role as Role;
  }

  // === Internal Methods ===

  /**
   * Add a message with validation and auto-compact check
   */
  private async addMessage(message: Message): Promise<void> {
    this.messages.push(message);
    this.updateTokenCount(message);

    // Call onMessage callback if set
    if (this.options.onMessage) {
      this.options.onMessage(this.messages);
    }

    // Check for auto-compact
    if (this.tokenCount > this.options.tokenThreshold) {
      await this.compact();
    }
  }

  /**
   * Handle misordered role transition
   */
  private handleMisorder(newRole: Role, newMessage: Partial<Message>): void {
    const lastRole = this.getLastRole();
    const lastMessage = this.messages[this.messages.length - 1];

    const gap = this.diagnoseGap(newRole);

    this.options.onMisorder({
      from: lastRole!,
      to: newRole,
      gap,
      context: { lastMessage, newMessage },
    });

    // For missing_assistant, we try to auto-fix by generating a bridge
    if (gap === 'missing_assistant') {
      this.generateBridgeResponse(newMessage);
    }
    // For other gaps, we just warn and proceed
  }

  /**
   * Diagnose the gap type for a misordered transition
   */
  private diagnoseGap(newRole: Role): MisorderWarning['gap'] {
    const lastRole = this.getLastRole();

    if (lastRole === 'user' && newRole === 'tool') {
      return 'missing_assistant';
    }
    if (lastRole === 'assistant' && newRole === 'assistant') {
      return 'unexpected_duplicate';
    }
    if (lastRole === 'tool' && newRole === 'user') {
      // This should have been handled by microCompact
      return 'missing_assistant';
    }
    return 'invalid_sequence';
  }

  /**
   * Generate a bridge assistant response for missing assistant
   */
  private async generateBridgeResponse(intendedMessage: Partial<Message>): Promise<void> {
    console.warn(chalk.yellow('[Trialogue] Generating bridge response...'));

    // Generate a brief acknowledgment
    const response = await retryChat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: 'Generate a brief acknowledgment (max 10 words) to continue.',
        },
      ],
    });

    const bridgeContent = response.message.content || 'Understood. Continuing.';
    this.messages.push({
      role: 'assistant',
      content: bridgeContent,
    });
    this.updateTokenCount(this.messages[this.messages.length - 1]);

    console.warn(chalk.yellow(`[Trialogue] Bridge: "${bridgeContent}"`));

    // Now add the intended message
    if (intendedMessage.role === 'tool') {
      this.messages.push(intendedMessage as Message);
      this.updateTokenCount(intendedMessage as Message);
    }
  }

  /**
   * Update token count incrementally
   */
  private updateTokenCount(message: Message): void {
    if (message.content) {
      this.tokenCount += message.content.split(/\s+/).length;
    }
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        this.tokenCount += JSON.stringify(tc.function.arguments).split(/\s+/).length;
      }
    }
  }

  /**
   * Estimate token count for a message array (full scan)
   */
  private estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      if (msg.content) {
        total += msg.content.split(/\s+/).length;
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += JSON.stringify(tc.function.arguments).split(/\s+/).length;
        }
      }
    }
    return total;
  }

  /**
   * Run microCompact: collapse consecutive tool results into user message
   */
  private runMicroCompact(): void {
    const newMessages: Message[] = [];
    let pendingTools: Message[] = [];

    for (const msg of this.messages) {
      if (msg.role === 'tool') {
        pendingTools.push(msg);
      } else {
        if (pendingTools.length > 0) {
          // Combine pending tools into a single user message
          const combined = pendingTools.map((m) => m.content).join('\n---\n');
          newMessages.push({ role: 'user', content: `Previous tool results:\n${combined}` });
          pendingTools = [];
        }
        newMessages.push(msg);
      }
    }

    // Handle any remaining pending tools
    if (pendingTools.length > 0) {
      const combined = pendingTools.map((m) => m.content).join('\n---\n');
      newMessages.push({ role: 'user', content: `Previous tool results:\n${combined}` });
    }

    this.messages = newMessages;
    this.tokenCount = this.estimateTokens(this.messages);
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
  }

  /**
   * Run auto-compact: save transcript and summarize with LLM
   */
  private async runAutoCompact(): Promise<Message[]> {
    // Ensure transcript directory exists
    ensureDirs();
    const transcriptDir = path.join(getMyccDir(), 'transcripts');
    if (!fs.existsSync(transcriptDir)) {
      fs.mkdirSync(transcriptDir, { recursive: true });
    }

    // Save full transcript to disk
    const timestamp = Math.floor(Date.now() / 1000);
    const transcriptPath = path.join(transcriptDir, `transcript_${timestamp}.jsonl`);

    const writeStream = fs.createWriteStream(transcriptPath);
    for (const msg of this.messages) {
      writeStream.write(JSON.stringify(msg) + '\n');
    }
    writeStream.end();

    this.options.onCompact(transcriptPath);

    // Ask LLM to summarize
    const conversationText = JSON.stringify(this.messages).slice(0, 80000);

    const response = await retryChat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content:
            'Summarize this conversation for continuity. Include: ' +
            '1) What was accomplished, 2) Current state, 3) Key decisions made. ' +
            'Be concise but preserve critical details.\n\n' +
            conversationText,
        },
      ],
    });

    const summary = response.message.content || '(no summary)';

    return [
      {
        role: 'user',
        content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
      },
      {
        role: 'assistant',
        content: 'Understood. I have the context from the summary. Continuing.',
      },
    ];
  }

  // === Default Callbacks ===

  private defaultOnMisorder(warning: MisorderWarning): void {
    console.warn(
      chalk.yellow(`[Trialogue] Misordered transition: ${warning.from} → ${warning.to}`)
    );
    console.warn(chalk.yellow(`[Trialogue] Gap: ${warning.gap}`));
  }

  private defaultOnToolMisalign(warning: ToolAlignmentWarning): void {
    console.warn(
      chalk.yellow(`[Trialogue] Tool alignment issue: ${warning.functionName}`)
    );
    console.warn(chalk.yellow(`[Trialogue] Issue: ${warning.issue}`));
    if (warning.expectedName) {
      console.warn(chalk.yellow(`[Trialogue] Expected: ${warning.expectedName}`));
    }
  }

  private defaultOnCompact(transcriptPath: string): void {
    console.log(chalk.blue(`[auto-compact triggered: ${transcriptPath}]`));
  }
}