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
import { minifyMessages, minifyForHint } from '../utils/llm-chat-minifier.js';
import { estimateTokens, estimateTokensForMessages } from '../utils/token.js';
import { ResultTooLargeError } from '../types.js';
import { getMyccDir, getLongtextDir, ensureDirs } from '../config.js';
import { getTokenThreshold } from '../config.js';
import { agentIO } from './agent-io.js';

type Role = 'system' | 'user' | 'assistant' | 'tool';

interface MisorderWarning {
  from: Role;
  to: Role;
  gap: 'missing_assistant' | 'missing_tool_response' | 'unexpected_duplicate' | 'invalid_sequence';
  context: { lastMessage?: Message; newMessage?: Partial<Message> };
}

interface ToolAlignmentWarning {
  functionName: string;
  toolCallId?: string;
  issue: 'no_pending_calls' | 'id_not_found' | 'name_mismatch' | 'orphan_result';
  expectedId?: string;
  expectedName?: string;
}

interface TriologueOptions {
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
  private options: Required<Omit<TriologueOptions, 'wiki'>> & Pick<TriologueOptions, 'wiki'>;
  // Project context files (in-memory only, not persisted)
  private projectContext: Message[] = [];

  constructor(options: TriologueOptions = {}) {
    const hintThreshold = options.hintThreshold ?? 10;
    const tokenThreshold = options.tokenThreshold ?? 50000;
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
   * Add instruction when mindmap is loaded
   * Tells LLM to use the recall tool to explore the mindmap
   */
  setMindmapInstruction(): void {
    this.projectContext.push(
      { role: 'user', content: '[System] A mindmap (knowledge tree) is available. Use the `recall` tool to explore it. Start with `recall("/")` to see top-level nodes, then drill down into children. The mindmap contains compiled project knowledge and guidance.' },
      { role: 'assistant', content: 'Understood. I will use the recall tool to explore the mindmap. Starting with recall("/") to see the top-level structure.' }
    );
  }

  /**
   * Add instruction when no mindmap exists
   * Tells LLM to read CLAUDE.md directly and NOT use the recall tool
   */
  setNoMindmapInstruction(): void {
    this.projectContext.push(
      { role: 'user', content: '[System] No mindmap found. Please read CLAUDE.md to understand the project context and structure. IMPORTANT: The recall tool will not work without a mindmap, so do NOT use it. Use read_file tool to explore CLAUDE.md instead.' },
      { role: 'assistant', content: 'Understood. I will read CLAUDE.md using read_file to understand the project. I will NOT use the recall tool since no mindmap is available.' }
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
   * @param focus - Optional focus topic to include in summarization
   */
  async compact(focus?: string): Promise<void> {
    const compacted = await this.runAutoCompact(focus);
    this.messages = compacted;
    this.tokenCount = estimateTokensForMessages(this.messages);
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
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
  }

  /**
   * Generate a hint round with problem analysis
   * Adds user message with analysis (single LLM call, no acknowledgment)
   * Note: Confusion tracking is now handled by ctx.core, not by Triologue
   * @param abortController - Abort controller for ESC handling
   * @param confusionScore - Current confusion score
   * @param confusionBreakdown - Breakdown of confusion factors
   * @param pendingSkills - Skills with 'when' but no compiled condition (for notification)
   * @returns 'aborted' if ESC was pressed, 'success' if completed
   */
  async generateHintRound(
    abortController: AbortController,
    confusionScore: number,
    confusionBreakdown: string,
    pendingSkills?: string[]
  ): Promise<'aborted' | 'success'> {
    if (agentIO.isNeglectedMode()) return 'aborted';

    // Extract focused context for hint generation
    const context = minifyForHint(
      this.messages,
      confusionScore,
      confusionBreakdown
    );

    // Get wiki domains for knowledge search suggestion
    const domains = this.options.wiki ? await this.options.wiki.listDomains() : [];
    const domainInfo = domains.length > 0
      ? domains.map(d => `- ${d.domain_name}${d.description ? `: ${d.description}` : ''}`).join('\n')
      : 'No domains available';

    // JSON Schema for structured output
    const hintSchema = {
      type: 'object',
      properties: {
        blocker: {
          type: 'string',
          description: 'What is preventing progress. Use "no blockers" if there are no real blockers. Be specific and concise.',
        },
        next_step: {
          type: 'string',
          description: 'Concrete, actionable next step. If no blockers, suggest continuing current work.',
        },
        focus_on: {
          type: 'string',
          description: 'Key area or priority to focus on.',
        },
        wiki_domain: {
          type: 'string',
          description: 'Domain name from available domains. Leave empty if no wiki search needed.',
        },
        wiki_query: {
          type: 'string',
          description: 'Search query for the wiki. Leave empty if no wiki search needed.',
        },
      },
      required: ['blocker', 'next_step', 'focus_on', 'wiki_domain', 'wiki_query'],
    };

    const analysisPrompt = `## User's Intent
${context.userIntent}

## Current Progress
${context.recentTools.map(t => `- ${t.name}: ${t.status}`).join('\n')}

## Problems Encountered
${context.errors.length > 0 ? context.errors.map(e => `- ${e.tool}: ${e.error}`).join('\n') : 'None'}

## Stuck Patterns
${context.repetition.length > 0 ? context.repetition.map(r => `- ${r.tool} called ${r.count} times`).join('\n') : 'None'}

## Confusion Score: ${context.confusionScore}
${context.confusionBreakdown}

## Available Wiki Domains
${domainInfo}

---

Analyze the gap between the user's intent and current progress. 

CRITICAL INSTRUCTIONS:
1. If there are NO REAL blockers preventing progress, set blocker to exactly: "no blockers"
2. Do NOT fabricate blockers. "no blockers" means the agent should simply continue with the current task.
3. Only suggest wiki_domain and wiki_query if there's genuine knowledge gap. Leave empty strings if no wiki search needed.
4. The reply should be a JSON string, with no extra commentary. JSON schema must be respected. The schema is:
${JSON.stringify(hintSchema, null, 2)}
`;

    // Retry loop: parse JSON until success or abort
    while (true) {
      // Check if already aborted
      if (abortController.signal.aborted) {
        return 'aborted';
      }

      try {
        // Get analysis from LLM with JSON schema enforcement
        const response = await retryChat(
          {
            model: MODEL,
            messages: [
              {
                role: 'user',
                content: analysisPrompt,
              },
            ],
            format: hintSchema,
            // use thinking mode for hint round analysis
            think: true,
          },
          { signal: abortController.signal, neglected: agentIO.isNeglectedMode() },
        );

        const rawContent = response.message.content || '{}';

        // Parse JSON response (schema enforcement should guarantee valid JSON)
        // Note: LLM may still wrap JSON in markdown code blocks despite format constraint
        let hintData: {
          blocker: string;
          next_step: string;
          focus_on: string;
          wiki_domain: string;
          wiki_query: string;
        };

        try {
          // Extract JSON from potentially markdown-wrapped content
          const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            console.log('[hint round] No JSON found in response, retrying...');
            continue;
          }
          hintData = JSON.parse(jsonMatch[0]);
        } catch {
          // Parse failed - log and retry
          console.log('[hint round] JSON parse failed, retrying...');
          continue;
        }

        // Validate required fields exist
        if (
          typeof hintData.blocker !== 'string' ||
          typeof hintData.next_step !== 'string' ||
          typeof hintData.focus_on !== 'string' ||
          typeof hintData.wiki_domain !== 'string' ||
          typeof hintData.wiki_query !== 'string'
        ) {
          console.log('[hint round] Missing required fields, retrying...');
          continue;
        }

        // Format hint data for better readability
        const hintLines: string[] = ['[HINT] Problem Analysis:'];
        hintLines.push(``);
        hintLines.push(`**Blocker:** ${hintData.blocker}`);
        hintLines.push(`**Next Step:** ${hintData.next_step}`);
        hintLines.push(`**Focus On:** ${hintData.focus_on}`);
        if (hintData.wiki_domain && hintData.wiki_query) {
          hintLines.push(`**Wiki Search:** Domain="${hintData.wiki_domain}", Query="${hintData.wiki_query}"`);
        } else {
          hintLines.push(`**Wiki Search:** None`);
        }
        // Add pending skills notification if any
        if (pendingSkills && pendingSkills.length > 0) {
          hintLines.push(``);
          hintLines.push(`**Pending Skill Compilation:** ${pendingSkills.map(s => `'${s}'`).join(', ')}`);
          hintLines.push(`Use \`skill_compile\` to compile these skills so the hook system can process them.`);
        }
        hintLines.push(``);
        hintLines.push(`Use \`ctx.core.brief()\` to provide status updates as needed.`);

        const hintMessage: Message = {
          role: 'user',
          content: hintLines.join('\n'),
        };

        this.messages.push(hintMessage);
        this.updateTokenCount(hintMessage);

        this.options.onHint();
        return 'success';
      } catch (err) {
        if (err instanceof Error && err.message === 'Request aborted') {
          return 'aborted'; // ESC pressed - abort hint round
        }
        throw err;
      }
    }
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

    // Inject project context (README, mindmap instructions, etc.)
    result.push(...this.projectContext);

    // Conversation history
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
   * Get last message role, or null if empty
   */
  getLastRole(): Role | null {
    if (this.messages.length === 0) return null;
    return this.messages[this.messages.length - 1].role as Role;
  }

  /**
   * Get current token count
   */
  getTokenCount(): number {
    return this.tokenCount;
  }

  /**
   * Get token threshold
   */
  getTokenThreshold(): number {
    return this.options.tokenThreshold;
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
    this.tokenCount += estimateTokens(message);
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
    this.tokenCount = estimateTokensForMessages(this.messages);
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
  }

  /**
   * Run auto-compact: save transcript and summarize with LLM
   * @param focus - Optional focus topic to emphasize in summary
   */
  private async runAutoCompact(focus?: string): Promise<Message[]> {
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
      writeStream.write(`${JSON.stringify(msg)}\n`);
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
      `Available wiki domains:\n${domainList}\n\n` +
      `IMPORTANT: Only persist knowledge that matches one of the available domains above.\n` +
      `For knowledge worth remembering, note as: "Knowledge: [domain] - [fact/rule]"\n` +
      `Skip opinions, temporary details, or knowledge that does not fit any domain.\n\n`
      : '';

    const focusInstruction = focus
      ? `\n**Focus Area:** Pay special attention to information related to "${focus}" and ensure the summary captures all relevant details about this topic.\n`
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
            `3) Key decisions made\n${knowledgeInstruction
            }${focusInstruction}${conversationText}`,
        },
      ],
    });

    const summary = response.message.content || '(no summary)';

    const summaryPrefix = focus
      ? `[Conversation compressed. Focus: ${focus}. Transcript: ${transcriptPath}]\n\n`
      : `[Conversation compressed. Transcript: ${transcriptPath}]\n\n`;

    return [
      {
        role: 'user',
        content: `${summaryPrefix}${summary}`,
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

  // === Checkpoint Methods ===

  /**
   * Find the last open checkpoint in message history
   * @returns Checkpoint info if found, null otherwise
   */
  findOpenCheckpoint(): { id: string; description: string } | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === 'user') {
        const match = msg.content.match(/^\[CHECKPOINT ([a-z0-9]{8}): (.+)\]$/);
        if (match) {
          return { id: match[1], description: match[2] };
        }
      }
    }
    return null;
  }

  /**
   * Find all checkpoints in message history
   * @returns Array of checkpoint info
   */
  findAllCheckpoints(): Array<{ id: string; description: string }> {
    const checkpoints: Array<{ id: string; description: string }> = [];
    for (const msg of this.messages) {
      if (msg.role === 'user') {
        const match = msg.content.match(/^\[CHECKPOINT ([a-z0-9]{8}): (.+)\]$/);
        if (match) {
          checkpoints.push({ id: match[1], description: match[2] });
        }
      }
    }
    return checkpoints;
  }

  /**
   * Find a checkpoint by ID in message history
   * @param id - The checkpoint ID to find
   * @returns Checkpoint info with index if found, null otherwise
   */
  findCheckpointById(id: string): { id: string; description: string; index: number } | null {
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role === 'user') {
        const regex = new RegExp(`^\\[CHECKPOINT ${id}: (.+)\\]$`);
        const match = msg.content.match(regex);
        if (match) {
          return { id, description: match[1], index: i };
        }
      }
    }
    return null;
  }

  /**
   * Generate a random checkpoint ID (8 lowercase alphanumeric characters)
   */
  static generateCheckpointId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  /**
   * Get messages from a specific index to the end
   * @param startIndex - The starting index
   * @returns Messages from startIndex to end
   */
  getMessagesFrom(startIndex: number): Message[] {
    return this.messages.slice(startIndex);
  }

  /**
   * Replace messages from startIndex onwards with recap summary
   * Used by recap tool to compress checkpoint messages into summary
   * @param startIndex - Index of checkpoint message (inclusive)
   * @param userMessage - User recap message to insert
   * @param assistantMessage - Assistant acknowledgment to insert
   */
  recapMessages(startIndex: number, userMessage: Message, assistantMessage: Message): void {
    // Keep messages before startIndex
    const keptMessages = this.messages.slice(0, startIndex);

    // Replace with summary pair
    this.messages = [...keptMessages, userMessage, assistantMessage];

    // Recalculate token count
    this.tokenCount = estimateTokensForMessages(this.messages);

    // Clear pending tool calls (any calls from the recapped messages are now invalid)
    this.pendingToolCalls.clear();
    this.pendingToolCallOrder = [];
  }
}
