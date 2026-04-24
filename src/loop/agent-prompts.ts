/**
 * agent-prompts.ts - System prompt building utilities
 */

import * as os from 'os';
import type { AgentContext } from '../types.js';

/**
 * Detect platform-specific information
 */
function getPlatformInfo(): { platform: string; shell: string; pathSep: string; home: string; escapeChar: string } {
  const platform = os.platform();
  const isWin = platform === 'win32';
  const isMac = platform === 'darwin';
  
  return {
    platform: isWin ? 'Windows' : isMac ? 'macOS' : 'Linux',
    shell: isWin ? 'cmd.exe or PowerShell' : 'bash/zsh',
    pathSep: isWin ? 'backslash (\\)' : 'forward slash (/)',
    home: os.homedir(),
    escapeChar: isWin ? 'caret (^)' : 'backslash (\\)',
  };
}

/**
 * Build system prompt based on agent context and identity
 */
export function buildSystemPrompt(
  ctx: AgentContext,
  identity?: { name: string; role: string }
): string {
  const workDir = ctx.core.getWorkDir();
  const platformInfo = getPlatformInfo();

  // Current date/time for context (helps with time-sensitive queries like web search)
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentYear = now.getFullYear();

  // Knowledge boundary section - teach LLM to recognize gaps and seek knowledge
  const knowledgeBoundary = [
    '## Knowledge Boundary',
    '',
    'You have access to these knowledge sources:',
    '- **Skills**: Specialized knowledge for specific tasks. Use `skill_load(name="list")` to discover, then `skill_load(name="<name>")` to load.',
    '- **Wiki**: Project knowledge base (RAG). Use `wiki_get(query, domain)` to retrieve relevant documents.',
    '- **Web**: Current information from the internet. Use `web_search(query)` and `web_fetch(url)`.',
    '- **Teammates**: Parallel expertise for complex tasks. Use `tm_create(name, role, prompt)` to spawn specialists.',
    '',
    'When you encounter something outside your knowledge:',
    '1. PAUSE and recognize the gap',
    '2. Use the appropriate tool to fill it',
    '3. Continue with enhanced knowledge',
    '',
    'Do NOT guess. When in doubt, seek knowledge first.',
  ].join('\n');

  // Platform-specific guidance
  const isWin = platformInfo.platform === 'Windows';
  const platformGuidance = [
    '## Platform',
    `Platform: ${platformInfo.platform}`,
    `Shell: ${platformInfo.shell}`,
    `Path separator: ${platformInfo.pathSep}`,
    `Escape character: ${platformInfo.escapeChar}`,
    '',
    '### Shell Commands',
    isWin
      ? '- Use PowerShell or cmd syntax: `Get-Content file`, `Copy-Item src dest`'
      : '- Use bash/zsh syntax: `cat file`, `cp src dest`',
    '- Always use forward slashes (/) in file paths for cross-platform compatibility',
    '- Avoid platform-specific paths like `C:\\Users\\...` - use relative paths when possible',
    '',
    '### Escaping',
    isWin
      ? '- In cmd: use ^ to escape special chars (e.g., ^| for |)\n- In PowerShell: use backtick ` to escape (e.g., `$ for $)'
      : '- In bash/zsh: use backslash \\ to escape (e.g., \\$ for $)',
    '- For JSON/strings: use double quotes and escape inner quotes with backslash',
    '- When in doubt: use single quotes for literal strings in bash/zsh, double quotes in PowerShell',
  ].join('\n');

  // Common suffix for all prompts
  const common = [
    knowledgeBoundary,
    '',
    platformGuidance,
    '',
    '## Calendar',
    `Current date: ${currentDate} (year: ${currentYear})`,
    '',
    '## Output Behavior',
    'Respond concisely - do not repeat what tools have already displayed.',
  ].join('\n');

  // For child process, include identity and collaboration guidance
  if (identity) {
    return [
      `You are ${identity.name}, a specialized agent working as part of a team, created by the "lead".`,
      `Your role is ${identity.role}. You are working at ${workDir}.`,

      'You have only 3 ways to interact with others:',
      '1. use mail_to tool to inform other teammates.',
      '2. use question tool to pause and get input from the user.',
      '3. use brief tool to output debugging info to the user.',
      // to prevent mail flood.
      'REMEMBER: you cannot use the same type of tool from the above 3 tools consecutively.',

      'When you choose not to use any tool (thus finishing the task), your ending words will be mailed to "lead" automatically.',

      'When you feel lost about the context, send mail to "lead".',
      common,
    ].join('\n');
  }

  // Main process (lead agent) system prompt
  const hasTeam = ctx.team.printTeam() !== 'No teammates.';

  if (hasTeam) {
    return [
      `You are the lead of a coding agent team at ${workDir}.`,
      `Your role: coordinate teammates, collect results, and ensure task completion.`,

      `## Team Workflow`,
      `1. Create teammates with tm_create (each gets a role and instructions)`,
      `2. Write kickoff todos with todo_write to plan the work`,
      `3. Distribute tasks using issue_create - teammates will claim tasks automatically.`,
      `4. Collect results from mailbox and integrate them`,

      `## Communication`,
      `You have access to the issue system to coordinate tasks`,
      `Also you can send mails to the teammates. Send mails only if necessary, and keep the content actionable.`,
      `If you find yourself waiting for the reply from the teammates, do not use tools in this round.`,
      `Remember that the teammates can directly ask questions to the user, and you will get a copy of the chat.`,
      `If you want to ask me questions, do not use any tool, just leave your question as the reply.`,

      `## Special Rules`,
      `- You must ask for grant BEFORE "git commit" with no exception. The permission is only valid for one commit, for the next commit you MUST ask for grant again.`,
      common,
    ].join('\n');
  }

  return [
    `You are a coding agent at ${workDir}.`,
    `Use tools to finish tasks. Use skills to access specialized knowledge.`,
    `## Task Management`,
    `Use issue_* for complex tasks (divide and conquer), todo_* for simple tracking.`,
    `## Team Mode`,
    `If the task would benefit from parallel work, create teammates with tm_create to form a team.`,
    `## Rules`,
    `- You must ask for grant BEFORE "git commit" with no exception. The permission is only valid for one commit, for the next commit you MUST ask for grant again.`,
    common,
  ].join('\n');
}