/**
 * agent-loop-helper.ts - Utility functions for agent loop
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import type { AgentContext } from '../types.js';
import { type SummaryPair } from '../session/restoration.js';
import { getSkillMatchThreshold, getMyccDir, setSessionContext, getSessionArg } from '../config.js';
import { clearAll } from '../context/memory-store.js';
import { createSessionFile, getSessionId, cleanupEmptySessions, loadSessionById, getSessionPathById, SessionNotFoundError, AmbiguousSessionError } from '../session/index.js';
import { prepareRestoration, readDosq, extractFirstQuery } from '../session/restoration.js';
import { agentIO } from './agent-io.js';

/**
 * Result of session initialization
 */
export interface SessionInit {
  sessionFilePath: string;
  triologuePath: string;
  restoredPair: SummaryPair | null;
  initialQuery: string | null;
}

/**
 * Build skill hint from wiki matching.
 * Only for queries with 5-1000 words (not too short, not too long).
 */
export async function buildSkillHint(query: string, ctx: AgentContext): Promise<string | null> {
  const wordCount = query.trim().split(/\s+/).length;
  
  // Skip if query is too short (less than 5 words)
  if (wordCount < 5) {
    ctx.core.verbose('skill-hint', `Query too short (${wordCount} words), skipping`);
    return null;
  }
  
  // Skip if query is too long (rough estimate: 4 chars per token)
  if (query.length > 4000) {
    ctx.core.verbose('skill-hint', 'Query too long for skill matching, skipping');
    return null;
  }

  try {
    ctx.core.verbose('skill-hint', `Searching skills for: "${query.slice(0, 50)}..."`);
    
    const threshold = getSkillMatchThreshold();
    const results = await ctx.wiki.get(query, {
      domain: 'skills',
      topK: 3,
      threshold,
    });

    if (results.length === 0) {
      ctx.core.verbose('skill-hint', 'No matching skills found');
      return null;
    }

    ctx.core.verbose('skill-hint', `Found ${results.length} matching skill(s): ${results.map(r => r.document.title).join(', ')}`);

    const hints: string[] = [];
    for (const result of results) {
      const skillName = result.document.title;
      const skillDesc = result.document.content.split('\n').find(line => line.startsWith('Description:'))?.replace('Description: ', '') || '';
      const similarity = (result.similarity * 100).toFixed(0);
      hints.push(`- **${skillName}** (${similarity}% match): ${skillDesc}. Use \`skill_load(name="${skillName}")\` to load it.`);
    }

    return `The following skills may be helpful:\n${hints.join('\n')}`;
  } catch (err) {
    ctx.core.verbose('skill-hint', `Skill matching failed: ${err}`);
    return null;
  }
}

/**
 * Restore an existing session by ID
 */
export async function restoreSession(sessionArg: string): Promise<SessionInit> {
  console.log(chalk.cyan(`Loading session: ${sessionArg}`));

  let session: import('../session/types.js').Session;
  try {
    session = loadSessionById(sessionArg);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      console.error(chalk.red(`Session not found: ${sessionArg}`));
      process.exit(1);
    }
    if (err instanceof AmbiguousSessionError) {
      console.error(chalk.red('Ambiguous session ID. Multiple matches found:'));
      for (const match of err.matches) {
        console.error(chalk.yellow(`  [${match.id.slice(0, 7)}] ${match.source} session`));
      }
      console.error(chalk.gray('Use a longer session ID prefix.'));
      process.exit(1);
    }
    throw err;
  }

  // Verify working directory matches session's project_dir
  const currentDir = process.cwd();
  if (currentDir !== session.project_dir) {
    console.error(chalk.red('Working directory mismatch.'));
    console.error(chalk.yellow(`Current: ${currentDir}`));
    console.error(chalk.yellow(`Session expects: ${session.project_dir}`));
    console.error(chalk.gray(`Run: cd "${session.project_dir}" && mycc --session ${session.id}`));
    process.exit(1);
  }

  // Validate session files exist
  const missingFiles = [
    session.lead_triologue,
    ...session.child_triologues,
  ].filter(p => !fs.existsSync(p));

  if (missingFiles.length > 0) {
    console.error(chalk.red(`Session files missing: ${missingFiles.join(', ')}`));
    process.exit(1);
  }

  console.log(chalk.cyan('Restoring session...'));

  const { pair, dosqPath } = await prepareRestoration(session);

  console.log(chalk.cyan('Session restored. DOSQ generated at:'));
  console.log(chalk.gray(`  ${dosqPath}`));

  // Open DOSQ in editor for user review
  try {
    const { openEditor } = await import('../utils/open-editor.js');
    openEditor([dosqPath]);
    console.log(chalk.gray('Opening DOSQ file in editor...'));
  } catch {
    console.log(chalk.yellow(`Please edit the DOSQ file manually: ${dosqPath}`));
  }

  console.log(chalk.yellow('Edit the DOSQ file if needed, then save and close to continue...'));
  await agentIO.ask(chalk.cyan('Press Enter when ready to continue > '));

  const dosqContent = readDosq(dosqPath);
  const initialQuery = extractFirstQuery(dosqContent);
  const triologuePath = session.lead_triologue;
  const sessionFilePath = getSessionPathById(session.id)
    || path.join(path.dirname(session.lead_triologue), '..', 'sessions', `${session.id}.json`);

  console.log(chalk.gray(`Restored session: ${session.id.slice(0, 7)}`));

  return { sessionFilePath, triologuePath, restoredPair: pair, initialQuery };
}

/**
 * Create a new session with fresh triologue and session files
 */
export function createNewSession(): SessionInit {
  const transcriptDir = path.join(getMyccDir(), 'transcripts');
  if (!fs.existsSync(transcriptDir)) {
    fs.mkdirSync(transcriptDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const triologuePath = path.join(transcriptDir, `lead-${timestamp}-triologue.jsonl`);
  fs.writeFileSync(triologuePath, '', 'utf-8');

  const sessionFilePath = createSessionFile(triologuePath);

  // Clean up empty sessions from previous runs
  const currentSessionId = getSessionId(sessionFilePath);
  const removed = cleanupEmptySessions(currentSessionId);
  if (removed > 0) {
    console.log(chalk.gray(`Cleaned up ${removed} empty session(s)`));
  }

  return { sessionFilePath, triologuePath, restoredPair: null, initialQuery: null };
}

/**
 * Initialize session - restore existing or create new
 * Sets session context before any database operations.
 */
export async function initializeSession(): Promise<SessionInit> {
  const sessionArg = getSessionArg();

  // Step 1: Get or create session to obtain session ID
  let result: SessionInit;
  if (sessionArg) {
    result = await restoreSession(sessionArg);
  } else {
    result = createNewSession();
  }

  // Step 2: Set session context for all database operations
  const sessionId = getSessionId(result.sessionFilePath);
  setSessionContext(sessionId);

  // Step 3: For NEW sessions, clear any orphan data from this session ID
  // (Restored sessions should keep their existing data)
  if (!sessionArg) {
    clearAll();
  }

  return result;
}