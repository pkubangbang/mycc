/**
 * /compact command - Manually trigger conversation compaction
 *
 * Usage:
 *   /compact           - Trigger manual compaction
 *   /compact <focus>  - Compact with focus topic (e.g., /compact mindmap design)
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';
import { loader } from '../context/shared/loader.js';

export const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Manually trigger conversation compaction (/compact [focus])',
  handler: async (context) => {
    const query = context.query;
    
    // Parse optional focus topic: /compact <focus>
    const match = query.match(/^\/compact\s+(.+)$/);
    const focus = match ? match[1].trim() : undefined;

    if (focus) {
      console.log(chalk.cyan(`\nTriggering manual compaction with focus: "${focus}"...\n`));
    } else {
      console.log(chalk.cyan('\nTriggering manual compaction...\n'));
    }

    // Cast triologue to access compact method with optional focus
    const triologue = context.triologue as { compact: (focus?: string, signal?: AbortSignal, tools?: unknown[], domains?: Array<{ domain_name: string; description?: string }>) => Promise<void> };

    try {
      // Same tool list the AUTOMATIC compact passes: the forkChat
      // working-memory extraction needs the tool schema to behave like the
      // live conversation, so passing `undefined` here made a manual compact
      // produce a strictly worse summary of the same conversation (row
      // lead-036).
      const compactTools = context.env ? loader.getToolsForScope(context.env.scope) : undefined;
      await triologue.compact(focus, undefined, compactTools, await context.ctx.wiki.listDomains());
      // Reset the SAME state the automatic path resets (llm.ts). Anything
      // missing here is a silent behaviour difference between "the loop
      // compacted" and "the user asked to compact":
      // - confusion index + embedding tracker: the duplication history refers
      //   to a conversation that has just been summarized away;
      // - sequence/hook per-turn counters: the session.* counters were reset;
      // - crossroadOccurred: the cooldown latch would otherwise silently skip
      //   crossroad detection on the next pass.
      context.ctx.core.resetConfusionIndex();
      context.env?.requestEmbeddingTracker.clear();
      context.sequence?.compactReset();
      // Reset hook dedup so a stop+replace hook suppressed by the per-turn cap
      // can re-fire after /compact — compactReset() resets the session.*
      // counters it was deduping against, but not the dedup set itself.
      context.hookExecutor?.resetTurn();
      if (context.env) context.env.crossroadOccurred = false;
      if (focus) {
        console.log(chalk.green(`Compaction complete (focus: ${focus}).`));
      } else {
        console.log(chalk.green('Compaction complete.'));
      }
      console.log(chalk.gray('The conversation has been summarized. Domains were included for knowledge persistence.'));
      console.log(chalk.gray('Stat counters (confusion index, embedding tracker, crossroad cooldown, session events) have been reset. Turn events and totalTurns are preserved.'));
    } catch (err) {
      console.log(chalk.red(`Compaction failed: ${(err as Error).message}`));
    }
  },
};