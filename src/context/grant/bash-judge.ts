/**
 * bash-judge.ts - 5-step bash command judging logic
 */

import type { ParsedIntent, BashJudgeResult } from './types.js';
import { parseIntent, validateIntent, isReadOnlyVerb, isMutationVerb } from './intent-parser.js';
import { checkDangerousCommand } from './dangerous-commands.js';
import { MODEL, retryMultipleChoice } from '../../ollama.js';

/**
 * Judge a bash command for plan mode safety
 * 
 * Steps:
 * 1. Check dangerous commands (pattern matching)
 * 2. Check intent grammar (fail fast with retry hint)
 * 3. Check mode + verb (local decision)
 * 4. LLM judging (parent only, for RUN verb)
 * 5. Ask user (parent only, when uncertain)
 * 
 * @param command - The bash command to execute
 * @param intent - The intent string (required)
 * @param mode - Current mode ('plan' or 'normal')
 * @param isChildProcess - Whether this is a child process
 * @param askUser - Function to ask user (only called in parent process)
 * @param escAware - Function to wrap operation with ESC awareness (optional)
 */
export async function judgeBash(
  command: string,
  intent: string,
  mode: 'plan' | 'normal',
  isChildProcess: boolean,
  askUser?: (query: string, asker: string) => Promise<string>,
  escAware?: <T>(operation: (abortController: AbortController) => Promise<T>, onCleanUp: () => T | Promise<T>) => Promise<T>
): Promise<BashJudgeResult> {
  // Step 1: Check dangerous commands (local, no LLM)
  const dangerousCheck = checkDangerousCommand(command);
  if (dangerousCheck.blocked) {
    return {
      decision: 'block',
      reason: `Command blocked: ${dangerousCheck.reason}`,
    };
  }

  // Step 2: Parse and validate intent (local, no LLM)
  const parsed = parseIntent(intent);
  const validation = validateIntent(parsed);
  
  if (!validation.valid) {
    // Return error with hint for LLM to retry
    return {
      decision: 'block',
      reason: validation.error + (validation.hint ? `\nHint: ${validation.hint}` : ''),
    };
  }

  // Step 3: Mode + verb check (local, no LLM)
  if (mode === 'normal') {
    // Normal mode: all verbs allowed (dangerous commands already blocked)
    return { decision: 'allow' };
  }

  // Plan mode: check verb
  if (isReadOnlyVerb(parsed!.verb)) {
    // READ, TEST are allowed in plan mode
    return { decision: 'allow' };
  }

  if (isMutationVerb(parsed!.verb)) {
    // WRITE, EDIT, DELETE, BUILD, INSTALL are blocked in plan mode
    return {
      decision: 'block',
      reason: `Cannot ${parsed!.verb} in plan mode. Verb "${parsed!.verb}" modifies state. Switch to normal mode first or use a read-only verb like [READ] or [TEST].`,
    };
  }

  // Step 4: RUN verb - need LLM analysis (parent only)
  if (parsed!.verb === 'RUN') {
    // Child processes cannot use LLM judging - must be explicit
    if (isChildProcess) {
      return {
        decision: 'block',
        reason: 'Ambiguous intent. Use a specific verb instead of RUN. Examples: [READ] SOURCE, [BUILD] ARTIFACT, [TEST] SOURCE',
      };
    }

    // Parent process: use LLM to analyze (with ESC awareness)
    const llmResult = await analyzeWithLLM(command, parsed!, escAware);
    
    if (llmResult.decision === 'allow') {
      return { decision: 'allow' };
    }
    
    if (llmResult.decision === 'block') {
      return {
        decision: 'block',
        reason: llmResult.reason || 'Command appears to modify state',
      };
    }

    // Step 5: Uncertain - ask user (parent only)
    if (!askUser) {
      // No askUser function provided (shouldn't happen in parent)
      return { decision: 'block', reason: 'Unable to determine command safety' };
    }

    // Ask user via core.question (ESC-aware)
    const userResponse = await askUser(
      `The command has ambiguous intent.\n\nCommand: ${command}\nPurpose: ${parsed!.purpose}\n\nAllow this command in plan mode? [y/N]`,
      'bash-judge'
    );
    
    // If user presses ESC, askUser returns empty string -> treat as "no"
    const approved = userResponse.toLowerCase().trim() === 'y' || 
                     userResponse.toLowerCase().trim() === 'yes';
    
    return {
      decision: approved ? 'allow' : 'block',
      reason: approved ? undefined : 'User denied the command',
    };
  }

  // Unknown verb (shouldn't reach here due to validation)
  return {
    decision: 'block',
    reason: `Unknown verb: ${parsed!.verb}`,
  };
}

/**
 * Analyze command with LLM to determine if it's a mutation
 * Only called for RUN verb in parent process
 */
async function analyzeWithLLM(
  command: string,
  parsed: ParsedIntent,
  escAware?: <T>(operation: (abortController: AbortController) => Promise<T>, onCleanUp: () => T | Promise<T>) => Promise<T>
): Promise<{ decision: 'allow' | 'block' | 'uncertain'; reason?: string }> {
  const systemPrompt = `You are a command analyzer. Determine if the following command modifies files or state.

Answer ONLY with exactly one of these words (no other text):
- READ (if the command is read-only, no file modifications)
- WRITE (if the command writes to files or modifies state)
- UNCERTAIN (if you cannot determine)

Be conservative: if in doubt, answer UNCERTAIN.`;

  const userPrompt = `Command: ${command}
Purpose: ${parsed.purpose}

Is this command read-only or does it modify state?`;

  try {
    // Use retryMultipleChoice for structured response with retry
    const operation = async (abortController: AbortController) => {
      return retryMultipleChoice(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        },
        ['READ', 'WRITE', 'UNCERTAIN'],
        { signal: abortController.signal, maxRetries: 2 }
      );
    };

    const onCleanUp = () => {
      // If ESC pressed, return uncertain to fall through to user prompt
      return null as string | null;
    };

    let result: string | null;
    
    if (escAware) {
      result = await escAware(operation, onCleanUp);
    } else {
      // No escAware provided (shouldn't happen in parent) - run directly
      const abortController = new AbortController();
      result = await operation(abortController);
    }

    // If ESC was pressed, result will be null
    if (result === null) {
      return { decision: 'uncertain' };
    }

    // Handle each case explicitly
    switch (result) {
      case 'READ':
        return { decision: 'allow' };
      case 'WRITE':
        return { decision: 'block', reason: 'LLM determined command modifies state' };
      case 'UNCERTAIN':
        return { decision: 'uncertain' };
      default:
        // This shouldn't happen due to retryMultipleChoice validation
        return { decision: 'uncertain' };
    }
  } catch {
    // If LLM fails or is interrupted, be conservative: ask user
    return { decision: 'uncertain' };
  }
}