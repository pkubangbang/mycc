/**
 * loader.ts - Dynamic tool and skill loader with hot-reload
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { watch } from 'fs';
import matter from 'gray-matter';

// Package root: resolve up from this file (src/context/loader.ts or dist/context/loader.js)
const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
import type { DynamicLoader, ToolDefinition, Skill, Tool, ToolScope, AgentContext, SkillModule } from '../types.js';
import { getToolsDir, getSkillsDir, ensureDirs } from './db.js';
import { bashTool } from '../tools/bash.js';
import { readTool } from '../tools/read.js';
import { writeTool } from '../tools/write.js';
import { editTool } from '../tools/edit.js';
import { todoWriteTool } from '../tools/todo_write.js';
import { skillLoadTool } from '../tools/skill_load.js';
import { tmCreateTool } from '../tools/tm_create.js';
import { tmRemoveTool } from '../tools/tm_remove.js';
import { tmAwaitTool } from '../tools/tm_await.js';
import { tmPrintTool } from '../tools/tm_print.js';
import { mailToTool } from '../tools/mail_to.js';
import { broadcastTool } from '../tools/broadcast.js';
import { questionTool } from '../tools/question.js';
import { briefTool } from '../tools/brief.js';
import { issueCreateTool } from '../tools/issue_create.js';
import { issueCloseTool } from '../tools/issue_close.js';
import { issueCommentTool } from '../tools/issue_comment.js';
import { issueClaimTool } from '../tools/issue_claim.js';
import { issueListTool } from '../tools/issue_list.js';
import { blockageCreateTool } from '../tools/blockage_create.js';
import { blockageRemoveTool } from '../tools/blockage_remove.js';
import { webFetchTool } from '../tools/web_fetch.js';
import { webSearchTool } from '../tools/web_search.js';
import { wtCreateTool } from '../tools/wt_create.js';
import { wtRemoveTool } from '../tools/wt_remove.js';
import { wtEnterTool } from '../tools/wt_enter.js';
import { wtLeaveTool } from '../tools/wt_leave.js';
import { wtPrintTool } from '../tools/wt_print.js';
import { bgCreateTool } from '../tools/bg_create.js';
import { bgPrintTool } from '../tools/bg_print.js';
import { bgRemoveTool } from '../tools/bg_remove.js';
import { bgAwaitTool } from '../tools/bg_await.js';
import { screenTool } from '../tools/screen.js';

/**
 * Built-in tools
 */
const builtInTools: ToolDefinition[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  todoWriteTool,
  skillLoadTool,
  tmCreateTool,
  tmRemoveTool,
  tmAwaitTool,
  tmPrintTool,
  mailToTool,
  broadcastTool,
  questionTool,
  briefTool,
  issueCreateTool,
  issueCloseTool,
  issueCommentTool,
  issueClaimTool,
  issueListTool,
  blockageCreateTool,
  blockageRemoveTool,
  webFetchTool,
  webSearchTool,
  wtCreateTool,
  wtRemoveTool,
  wtEnterTool,
  wtLeaveTool,
  wtPrintTool,
  bgCreateTool,
  bgPrintTool,
  bgRemoveTool,
  bgAwaitTool,
  screenTool,
];

/**
 * Dynamic loader implementation
 * Implements: DynamicLoader + ToolLoader + SkillModule
 */
export class Loader implements DynamicLoader, SkillModule {
  private tools: Map<string, ToolDefinition> = new Map();
  private skills: Map<string, Skill> = new Map();
  private toolWatcher: fs.FSWatcher | null = null;
  private skillWatcher: fs.FSWatcher | null = null;
  private silent: boolean;

  constructor(silent: boolean = false) {
    this.silent = silent;
  }

  /**
   * Load all tools and skills from directories
   */
  async loadAll(): Promise<void> {
    ensureDirs();

    // Load built-in tools first
    this.loadBuiltInTools();

    // Then load dynamic tools (can override built-in)
    await this.loadDynamicTools();

    this.loadSkills();
  }

  /**
   * Load built-in tools from src/tools/
   */
  private loadBuiltInTools(): void {
    for (const tool of builtInTools) {
      this.tools.set(tool.name, tool);
      if (!this.silent) {
        console.log(`[loader] Loaded built-in tool: ${tool.name}`);
      }
    }
  }

  /**
   * Load dynamic tools from .mycc/tools/
   */
  private async loadDynamicTools(): Promise<void> {
    const toolsDir = getToolsDir();

    if (!fs.existsSync(toolsDir)) {
      fs.mkdirSync(toolsDir, { recursive: true });
      return;
    }

    const files = fs.readdirSync(toolsDir);
    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        await this.reloadTool(path.join(toolsDir, file));
      }
    }
  }

  /**
   * Reload a single tool file (dynamic tools only)
   */
  private async reloadTool(filepath: string): Promise<void> {
    try {
      // Use dynamic import with cache-busting
      const modulePath = path.isAbsolute(filepath)
        ? pathToFileURL(filepath).href
        : pathToFileURL(path.resolve(filepath)).href;

      // Add timestamp to bust cache
      const module = await import(`${modulePath}?t=${Date.now()}`);
      const tool = module.default as ToolDefinition;

      if (!tool || !tool.name) {
        if (!this.silent) {
          console.warn(`[loader] Invalid tool definition: ${filepath}`);
        }
        return;
      }

      this.tools.set(tool.name, tool);
      if (!this.silent) {
        console.log(`[loader] Loaded tool: ${tool.name}`);
      }
    } catch (err) {
      if (!this.silent) {
        console.error(`[loader] Failed to load tool ${filepath}:`, (err as Error).message);
      }
    }
  }

  /**
   * Load all skills from both project skills/ and .mycc/skills/
   */
  loadSkills(): Promise<void> {
    // Ensure .mycc/skills exists
    ensureDirs();

    // Load from built-in skills/ directory (package root)
    const builtInSkillsDir = path.join(packageRoot, 'skills');
    this.loadSkillsFromDir(builtInSkillsDir);

    // Load from .mycc/skills directory (relative to where mycc command starts)
    const myccSkillsDir = getSkillsDir();
    this.loadSkillsFromDir(myccSkillsDir);

    return Promise.resolve();
  }

  /**
   * Load skills from a specific directory (including subdirectories)
   * Valid entrypoints:
   * - ${dir}/*.md - single file skills at root level
   * - ${dir}/${name}/SKILL.md - skill in folder structure
   */
  private loadSkillsFromDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      return;
    }

    const findSkillFiles = (currentDir: string, isRoot: boolean): string[] => {
      const files: string[] = [];
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findSkillFiles(fullPath, false));
        } else if (isRoot && entry.name.endsWith('.md')) {
          // At root level: any .md file is a valid skill
          files.push(fullPath);
        } else if (!isRoot && entry.name === 'SKILL.md') {
          // In subdirectories: only SKILL.md is a valid entrypoint
          files.push(fullPath);
        }
      }
      return files;
    };

    const skillFiles = findSkillFiles(dir, true);
    for (const file of skillFiles) {
      this.reloadSkill(file);
    }
  }

  /**
   * Reload a single skill file
   */
  private reloadSkill(filepath: string): void {
    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      const { data, content: body } = matter(content);

      if (!data.name) {
        if (!this.silent) {
          console.warn(`[loader] Missing 'name' in frontmatter: ${filepath}`);
        }
        return;
      }

      const skill: Skill = {
        name: data.name,
        description: data.description || '',
        keywords: data.keywords || [],
        content: body.trim(),
      };

      this.skills.set(skill.name, skill);
      if (!this.silent) {
        console.log(`[loader] Loaded skill: ${skill.name}`);
      }
    } catch (err) {
      if (!this.silent) {
        console.error(`[loader] Failed to load skill ${filepath}:`, (err as Error).message);
      }
    }
  }

  /**
   * Watch directories for changes (only dynamic directories need watching)
   * - .mycc/tools/ - dynamic tools (hot-reloadable)
   * - .mycc/skills/ - dynamic skills (hot-reloadable)
   * Built-in tools (src/tools/) and skills (skills/) are static and don't need watching.
   */
  watchDirectories(): void {
    const toolsDir = getToolsDir();
    const skillsDir = getSkillsDir();

    // Watch .mycc/tools/ for dynamic tool changes
    if (fs.existsSync(toolsDir)) {
      this.toolWatcher = watch(toolsDir, async (event, filename) => {
        if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
          const filepath = path.join(toolsDir, filename);
          if (!this.silent) {
            console.log(`[loader] Reloading tool: ${filename}`);
          }
          await this.reloadTool(filepath);
        }
      });
    }

    // Watch .mycc/skills/ for dynamic skill changes (recursive for subdirectories)
    if (fs.existsSync(skillsDir)) {
      this.skillWatcher = watch(skillsDir, { recursive: true }, (event, filename) => {
        if (filename && filename.endsWith('.md')) {
          // Only load valid entrypoints:
          // - Root level: any *.md file
          // - Subdirectories: only SKILL.md
          const isRootLevel = !filename.includes(path.sep);
          const isSkillEntrypoint = filename.endsWith(path.join(path.sep, 'SKILL.md'));

          if (isRootLevel || isSkillEntrypoint) {
            const filepath = path.join(skillsDir, filename);
            if (!this.silent) {
              console.log(`[loader] Reloading skill: ${filename}`);
            }
            this.reloadSkill(filepath);
          }
        }
      });
    }
  }

  /**
   * Stop watching directories
   */
  stopWatching(): void {
    this.toolWatcher?.close();
    this.skillWatcher?.close();
    this.toolWatcher = null;
    this.skillWatcher = null;
  }

  /**
   * Get a skill by name
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * List all skills (without content)
   * From SkillModule interface
   */
  listSkills(): Skill[] {
    return Array.from(this.skills.values()).map((s) => ({
      name: s.name,
      description: s.description,
      keywords: s.keywords,
      content: '', // Exclude content
    }));
  }

  /**
   * Format skills for prompt
   * From SkillModule interface
   */
  printSkills(): string {
    const skills = this.listSkills();
    if (skills.length === 0) {
      return 'No skills loaded.';
    }

    const lines = ['Available skills:'];
    for (const skill of skills) {
      const keywords = skill.keywords.length > 0 ? ` [${skill.keywords.join(', ')}]` : '';
      lines.push(`  - ${skill.name}: ${skill.description}${keywords}`);
    }
    return lines.join('\n');
  }

  /**
   * Get tools formatted for Ollama API, filtered by scope
   * From merged ToolLoader interface
   */
  getToolsForScope(scope: ToolScope): Tool[] {
    return Array.from(this.tools.values())
      .filter((t) => t.scope.includes(scope))
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })) as Tool[];
  }

  /**
   * Execute a tool by name
   * From merged ToolLoader interface
   */
  async execute(name: string, ctx: AgentContext, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Unknown tool: ${name}`;
    }

    try {
      const result = await tool.handler(ctx, args);
      return result;
    } catch (err) {
      return `Error executing ${name}: ${(err as Error).message}`;
    }
  }
}