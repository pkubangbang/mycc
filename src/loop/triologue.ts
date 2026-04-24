/**
 * triologue.ts - Message management with auto-compact and role validation
 *
 * Triologue manages the conversation history (messages) with:
 * - Automatic compaction when token threshold exceeded
 * - Role transition validation (detect misordered messages)
 * - Bridge response generation for gaps
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { retryChat, MODEL } from '../ollama.js';
import type { Message, ToolCall, WikiModule } from '../types.js';
import { minifyMessages } from '../utils/llm-chat-minifier.js';
import { ResultTooLargeError } from '../types.js';
import { getMyccDir, getLongtextDir, ensureDirs } from '../config.js';
import { getTokenThreshold } from '../config.js';
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

export interface TriologueOptions {
  /** Token threshold for auto-compact (default: 50000) */
  tokenThreshold?: number;
  /** Result size threshold in chars (default: 20000) */
  resultThreshold?: number;
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
  /** Wiki module for domain list during compact */
  wiki?: WikiModule;
}

export class Triologue {
  private messages: Message[] = [];
  private pendingToolCalls: Map<string, ToolCall> = new Map();
  private pendingToolCallOrder: string[] = []; // Track order for sequential resolution
  private tokenCount: number = 0;
  private systemPrompt: string | null = null;
  private confusion: ConfusionCalculator;
  private hintGenerated: boolean = false;
  private options: Required<Omit<TriologueOptions, 'wiki'>> & Pick<TriologueOptions, 'wiki'>;
  // Project context files (in-memory only, not persisted)
  private projectContext: Message[] = [];

  constructor(options: TriologueOptions = {}) {
    const hintThreshold = options.hintThreshold ?? 10;
    const tokenThreshold = options.tokenThreshold ?? 50000;
    this.confusion = new ConfusionCalculator(hintThreshold);
    this.options = {
      tokenThreshold,
      // default value is about half the TOKEN_THRESHOLD, so there won't be
      // "big blocks" that take more than half of the ctx length.
      resultThreshold: options.resultThreshold ?? Math.floor(tokenThreshold / 2),
      hintThreshold,
      onMisorder: options.onMisorder ?? this.defaultOnMisorder,
      onToolMisalign: options.onToolMisalign ?? this.defaultOnToolMisalign,
      onCompact: options.onCompact ?? this.defaultOnCompact,
      onMessage: options.onMessage ?? (() => {}),
      onHint: options.onHint ?? (() => {}),
      wiki: options.wiki,
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
   * Set CLAUDE.md content (project instructions)
   * Appends context pair to project context (appears before README.md if both set)
   * If content is too large, skips it entirely.
   */
  setClaudeMd(content: string): void {
    // Use 10% of TOKEN_THRESHOLD (converted to chars) as max size
    const maxChars = Math.floor(getTokenThreshold() * 4 * 0.1);
    if (content.length > maxChars) {
      console.log('[triologue] CLAUDE.md is too large to load, skipping');
      return;
    }
    this.projectContext.push(
      { role: 'user', content: `[Project Instructions - CLAUDE.md from project root, FYI]\n\n${content}` },
      { role: 'assistant', content: 'Understood. I have read the project instructions from CLAUDE.md.' }
    );
  }

  /**
   * Set README.md content (project context)
   * Appends context pair to project context (appears after CLAUDE.md if both set)
   * If content is too large, skips it entirely.
   */
  setReadmeMd(content: string): void {
    // Use 10% of TOKEN_THRESHOLD (converted to chars) as max size
    const maxChars = Math.floor(getTokenThreshold() * 4 * 0.1);
    if (content.length > maxChars) {
      console.log('[triologue] README.md is too large to load, skipping');
      return;
    }
    this.projectContext.push(
      { role: 'user', content: `[Project Context - README.md from project root, FYI]\n\n${content}` },
      { role: 'assistant', content: 'Understood. I have read the project context from README.md.' }
    );
  }

  /**
   * Add a user message (real user input - clears temporary hint)
   */
  user(content: string): void {
    // Run microCompact if transitioning from tool role
    if (this.getLastRole() === 'tool') {
      this.runMicroCompact();
    }
    this.addMessage({ role: 'user', content });
  }

  /**
   * Add a user message on behalf of user (synthetic/generated)
   * Used for system-generated messages that should appear as user.
   */
  onBehalfOfUser(content: string): void {
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

    // Check result size threshold
    const threshold = this.options.resultThreshold;
    if (result.length > threshold) {
      // Dump to file
      ensureDirs();
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).slice(2, 8);
      const filename = `${functionName}_${timestamp}_${randomSuffix}.txt`;
      const filepath = path.join(getLongtextDir(), filename);

      // Add header explaining why this file was created
      const header = `[DUMPED TOOL RESULT]\n` +
        `Tool: ${functionName}\n` +
        `Reason: Result exceeded ${threshold} char threshold (${result.length} chars)\n` +
        `Time: ${new Date(timestamp).toISOString()}\n` +
        `Use read_read tool to summarize, or bash with head/tail to read.\n` +
        `---\n\n`;
      fs.writeFileSync(filepath, header + result);

      // Throw error with file reference
      throw new ResultTooLargeError(
        functionName,
        filepath,
        result.length,
        threshold,
        result.slice(0, 1000)  // First 1000 chars as preview
      );
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
   * Skip all pending tool calls with placeholder results.
   * Called when ESC interrupts tool execution.
   * @param firstMessage - Message for the first interrupted tool
   * @param subsequentMessage - Message for remaining skipped tools (defaults to firstMessage)
   */
  skipPendingTools(firstMessage: string, subsequentMessage?: string): void {
    let isFirst = true;
    for (const id of this.pendingToolCallOrder) {
      const tc = this.pendingToolCalls.get(id);
      if (tc) {
        const msg = isFirst ? firstMessage : (subsequentMessage || firstMessage);
        this.addMessage({
          role: 'tool',
          tool_name: tc.function.name,
          content: msg,
          tool_call_id: id,
        });
        isFirst = false;
      }
    }
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
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

    this.confusion.onAssistantResponse();

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
   * Clear all messages and reset state
   * Called by /clear command
   */
  clear(): void {
    this.messages = [];
    this.tokenCount = 0;
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
    this.hintGenerated = false;
    this.confusion.reset();
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
    this.confusion.onError(result);
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
    const conversationText = minifyMessages(this.messages);

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
      // use thinking mode for hint round analysis
      think: true,
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
   * Get messages with system prompt and project context prepended
   */
  getMessages(): Message[] {
    const result: Message[] = [];

    if (this.systemPrompt) {
      result.push({ role: 'system', content: this.systemPrompt });
    }

    // Inject project context (before conversation history)
    result.push(...this.messages);

    return result;
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

  /**
   * Load a single restoration pair into the triologue without triggering onMessage callback.
   * Used during session restoration to preload summary context.
   * @param pair - A [user_message, assistant_message] tuple
   */
  loadRestoration(pair: [Message, Message]): void {
    this.messages.push(pair[0]);
    this.updateTokenCount(pair[0]);
    this.messages.push(pair[1]);
    this.updateTokenCount(pair[1]);
    // Reset hint flag since we're starting fresh with restored context
    this.hintGenerated = false;
    this.confusion.reset();
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

    // For missing_assistant, insert a static placeholder (no LLM call)
    if (gap === 'missing_assistant') {
      this.messages.push({
        role: 'assistant',
        content: '...',
      });
      this.updateTokenCount(this.messages[this.messages.length - 1]);
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
      writeStream.write(`${JSON.stringify(msg)  }\n`);
    }
    writeStream.end();

    this.options.onCompact(transcriptPath);

    // Get wiki domains for knowledge persistence instruction
    const domains = this.options.wiki ? await this.options.wiki.listDomains() : [];
    const domainList = domains.length > 0
      ? domains.map(d => `- ${d.domain_name}${d.description ? `: ${d.description}` : ''}`).join('\n')
      : '';

    // Ask LLM to summarize
    const conversationText = minifyMessages(this.messages);

    const knowledgeInstruction = domains.length > 0
      ? `4) Important knowledge to persist (if any)\n\n` +
        `Available wiki domains:\n${  domainList  }\n\n` +
        `IMPORTANT: Only persist knowledge that matches one of the available domains above.\n` +
        `For knowledge worth remembering, note as: "Knowledge: [domain] - [fact/rule]"\n` +
        `Skip opinions, temporary details, or knowledge that does not fit any domain.\n\n`
      : '';

    const response = await retryChat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content:
            `Summarize this conversation for continuity. Include:\n` +
            `1) What was accomplished\n` +
            `2) Current state\n` +
            `3) Key decisions made\n${ 
            knowledgeInstruction 
            }${conversationText}`,
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
      chalk.yellow(`[Triologue] Misordered transition: ${warning.from} → ${warning.to}`)
    );
    console.warn(chalk.yellow(`[Triologue] Gap: ${warning.gap}`));
  }

  private defaultOnToolMisalign(warning: ToolAlignmentWarning): void {
    console.warn(
      chalk.yellow(`[Triologue] Tool alignment issue: ${warning.functionName}`)
    );
    console.warn(chalk.yellow(`[Triologue] Issue: ${warning.issue}`));
    if (warning.expectedName) {
      console.warn(chalk.yellow(`[Triologue] Expected: ${warning.expectedName}`));
    }
  }

  private defaultOnCompact(transcriptPath: string): void {
    console.log(chalk.blue(`[auto-compact triggered: ${transcriptPath}]`));
  }
}