/**
 * plan_on.ts - Switch to plan mode (code changes prohibited)
 *
 * Scope: ['main', 'child'] - Available to all agents
 *
 * This tool switches the agent to plan mode where code changes are prohibited.
 * It can optionally specify files that are allowed to be edited during plan mode.
 *
 * Parameters:
 * - allowed_file: Optional path to a file that can be edited during plan mode
 *   (e.g., a documentation file). If specified, the user will be asked for permission.
 *
 * The tool will:
 * 1. If allowed_file is specified, ask user for permission
 * 2. Set the mode to 'plan'
 * 3. Configure the allowed file if permitted
 */

import type { ToolDefinition, AgentContext } from '../types.js';
import type { Core } from '../context/parent/core.js';
import type { TeamManager } from '../context/parent/team.js';
import path from 'path';

export const planOnTool: ToolDefinition = {
  name: 'plan_on',
  description: `Switch to plan mode where code changes are prohibited.

Use this tool when you want to plan without making code changes. In plan mode:
- File write/edit operations are blocked
- Bash commands are blocked
- You can still read files and search the web

Parameters:
- allowed_file: Optional path to a file that can be edited during plan mode (e.g., a doc file).
  If specified, the user will be asked for permission to allow edits to this file.

The tool will ask for user permission if allowed_file is specified. User can:
1. Press Enter or type 'y'/'yes' to allow the suggested file
2. Type 'n'/'no' to enter strict plan mode (no files allowed)
3. Type a different file path to allow that file instead`,
  input_schema: {
    type: 'object',
    properties: {
      allowed_file: {
        type: 'string',
        description: 'Optional path to a file that can be edited during plan mode (e.g., README.md, docs/plan.md). User permission is required.',
      },
    },
    required: [],
  },
  scope: ['main'],
  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const allowedFile = args.allowed_file as string | undefined;

    // If allowed_file is specified, ask for permission
    if (allowedFile) {
      // Resolve to absolute path for clarity
      const resolvedPath = path.isAbsolute(allowedFile)
        ? allowedFile
        : path.resolve(ctx.core.getWorkDir(), allowedFile);

      const prompt = `Mycc is entering the plan mode (code changes prohibited).

However, you may want to allow edits to this file:
  ${resolvedPath}

Allow edits to this file during plan mode?
  - Press Enter or type 'y'/'yes' to allow this file
  - Type 'n'/'no' to enter strict plan mode (no files allowed)
  - Or type a different file path to allow that file instead
    (e.g., "docs/new-plan.md" or "README.md")`;

      const response = await ctx.core.question(prompt, ctx.core.getName(), { onEsc: 'n' });

      // Parse response
      let normalized = response.trim().toLowerCase();
      if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
          (normalized.startsWith("'") && normalized.endsWith("'"))) {
        normalized = normalized.slice(1, -1).trim();
      }
      
      // Empty response (Enter key) means approve the suggested file
      const approved = normalized === '' || normalized === 'y' || normalized === 'yes';
      const denied = normalized === 'n' || normalized === 'no';

      if (denied) {
        // Outcome 2: n/no - enter strict plan mode
        ctx.core.brief('info', 'plan_on', 'Strict plan mode activated');
        const core = ctx.core as Core;
        core.setMode('plan');
        const team = ctx.team as TeamManager;
        team.broadcastModeChange('plan');
        return `Plan mode activated (strict - no files allowed for editing).\n\nAll code changes are prohibited.`;
      }

      if (approved) {
        // Outcome 1: y/yes/Enter - allow the suggested file
        const core = ctx.core as Core;
        core.setMode('plan', resolvedPath);
        const team = ctx.team as TeamManager;
        team.broadcastModeChange('plan');
        ctx.core.brief('info', 'plan_on', `Plan mode activated with allowed file: ${resolvedPath}`);
        return `Plan mode activated.\n\nAllowed file for editing: ${resolvedPath}\n\nAll other code changes are prohibited.`;
      }

      // Outcome 3: User typed a different file path
      const userFile = response.trim();

      // Heuristic to distinguish file paths from casual user responses
      function looksLikeFilePath(input: string): boolean {
        const trimmed = input.trim();
        if (!trimmed) return false;

        // Special path references: current dir, parent dir, root, Windows drive
        if (trimmed === '.' || trimmed === '..' || trimmed === '/' || /^[a-zA-Z]:$/.test(trimmed)) return true;

        // Factor 1: Has a file extension — the last segment must be a filename-like word
        // followed by a dot and extension (e.g., "README.md", "src/file.ts")
        // Supports compound extensions (.env.example, .d.ts) and hidden files (.env)
        // This rejects version numbers ("1.0"), prices ("$5.99"), and dotted phrases ("hello.world")
        const lastSegment = trimmed.split(/[/\\]/).pop() || trimmed;
        if (/^\.?[a-zA-Z0-9_~-]+(\.[a-zA-Z0-9_~-]+)*\.[a-zA-Z0-9]+$/.test(lastSegment)) return true;

        // Factor 2: Known extensionless filenames (dotfiles and conventional names)
        const knownFiles = new Set([
          'makefile', 'dockerfile', 'gemfile', 'procfile',
          '.gitignore', '.gitattributes', '.env', '.editorconfig',
          '.prettierrc', '.eslintrc', '.npmrc', '.nvmrc',
        ]);
        if (knownFiles.has(lastSegment.toLowerCase())) return true;

        // Factor 3: Contains a path separator with structural validation
        const hasSep = trimmed.includes('/') || trimmed.includes('\\');
        if (hasSep) {
          // Reject if whitespace immediately around separator (catches "yes / no")
          if (/[/\\]\s|\s[/\\]/.test(trimmed)) return false;
          // Reject if no alphanumeric characters (catches "+-*/")
          if (!/[a-zA-Z0-9]/.test(trimmed)) return false;
          // Reject single-character segments on both sides (catches "y/n", "a/b", "n/m")
          const segments = trimmed.split(/[/\\]+/).filter(s => s.length > 0);
          if (segments.length >= 2 && segments.every(s => s.length <= 2)) {
            // All segments are very short — likely a binary choice like "y/n", "on/off"
            // Only allow if at least one segment has a dot (extension) or is >2 chars
            if (!segments.some(s => s.length > 2 || s.includes('.'))) return false;
          }
          return true;
        }

        return false;
      }

      if (!looksLikeFilePath(userFile)) {
        // User typed something that doesn't look like a file path (e.g., "hold on", "wait")
        // — treat as strict plan mode
        ctx.core.brief('info', 'plan_on', 'Strict plan mode activated (user response not a file path)');
        const core = ctx.core as Core;
        core.setMode('plan');
        const team = ctx.team as TeamManager;
        team.broadcastModeChange('plan');
        return `Plan mode activated (strict - no files allowed for editing).\n\nThe user responded with "${userFile}" which does not look like a file path, so strict plan mode was applied. All code changes are prohibited.`;
      }

      const resolvedUserPath = path.isAbsolute(userFile)
        ? userFile
        : path.resolve(ctx.core.getWorkDir(), userFile);

      const core = ctx.core as Core;
      core.setMode('plan', resolvedUserPath);
      const team = ctx.team as TeamManager;
      team.broadcastModeChange('plan');
      ctx.core.brief('info', 'plan_on', `Plan mode activated with user-specified file: ${resolvedUserPath}`);
      return `Plan mode activated.\n\nAllowed file for editing: ${resolvedUserPath}\n\nAll other code changes are prohibited.`;
    }

    // No allowed_file specified - enter strict plan mode
    const core = ctx.core as Core;
    core.setMode('plan');
    const team = ctx.team as TeamManager;
    team.broadcastModeChange('plan');
    ctx.core.brief('info', 'plan_on', 'Plan mode activated (strict)');
    return `Plan mode activated.\n\nAll code changes are prohibited. You can still:\n- Read files\n- Search the web\n- Use other read-only tools`;
  },
};