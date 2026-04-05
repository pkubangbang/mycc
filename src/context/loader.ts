/**
 * loader.ts - Dynamic tool and skill loader with hot-reload
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { watch } from 'fs';

// Get the directory of this module (works for both source and compiled)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import matter from 'gray-matter';
import type { DynamicLoader, ToolDefinition, Skill, Tool, ToolScope, AgentContext } from '../types.js';
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
];

/**
 * Dynamic loader implementation
 */
export class Loader implements DynamicLoader {
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
  private loadSkills(): void {
    // Ensure .mycc/skills exists
    ensureDirs();

    // Load from built-in skills/ directory (relative to this module)
    // When compiled, this file is in dist/context/, so we go up 2 levels to get the package root
    const builtInSkillsDir = path.join(__dirname, '..', '..', 'skills');
    this.loadSkillsFromDir(builtInSkillsDir);

    // Load from project skills/ directory (current working directory)
    const projectSkillsDir = path.join(process.cwd(), 'skills');
    this.loadSkillsFromDir(projectSkillsDir);

    // Load from .mycc/skills directory
    const myccSkillsDir = getSkillsDir();
    this.loadSkillsFromDir(myccSkillsDir);
  }

  /**
   * Load skills from a specific directory (including subdirectories)
   */
  private loadSkillsFromDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      return;
    }

    // Recursively find all SKILL.md files
    const findSkillFiles = (currentDir: string): string[] => {
      const files: string[] = [];
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findSkillFiles(fullPath));
        } else if (entry.name === 'SKILL.md' || entry.name.endsWith('.md')) {
          files.push(fullPath);
        }
      }
      return files;
    };

    const skillFiles = findSkillFiles(dir);
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
   * Watch directories for changes
   */
  watchDirectories(): void {
    const toolsDir = getToolsDir();
    const myccSkillsDir = getSkillsDir();
    const projectSkillsDir = path.join(process.cwd(), 'skills');
    const builtInSkillsDir = path.join(__dirname, '..', '..', 'skills');

    // Watch tools directory
    this.toolWatcher = watch(toolsDir, async (event, filename) => {
      if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
        const filepath = path.join(toolsDir, filename);
        if (!this.silent) {
          console.log(`[loader] Reloading tool: ${filename}`);
        }
        await this.reloadTool(filepath);
      }
    });

    // Watch built-in skills directory recursively
    if (fs.existsSync(builtInSkillsDir)) {
      const builtInWatcher = watch(builtInSkillsDir, { recursive: true }, (event, filename) => {
        if (filename && filename.endsWith('.md')) {
          const filepath = path.join(builtInSkillsDir, filename);
          if (!this.silent) {
            console.log(`[loader] Reloading skill: ${filename}`);
          }
          this.reloadSkill(filepath);
        }
      });
      this.skillWatcher = builtInWatcher;
    }

    // Watch project skills directory recursively
    if (fs.existsSync(projectSkillsDir)) {
      const projectWatcher = watch(projectSkillsDir, { recursive: true }, (event, filename) => {
        if (filename && filename.endsWith('.md')) {
          const filepath = path.join(projectSkillsDir, filename);
          if (!this.silent) {
            console.log(`[loader] Reloading skill: ${filename}`);
          }
          this.reloadSkill(filepath);
        }
      });
      // Store as skillWatcher (overwrites if needed)
      this.skillWatcher = projectWatcher;
    }

    // Watch .mycc/skills directory
    if (fs.existsSync(myccSkillsDir)) {
      const myccWatcher = watch(myccSkillsDir, (event, filename) => {
        if (filename && filename.endsWith('.md')) {
          const filepath = path.join(myccSkillsDir, filename);
          if (!this.silent) {
            console.log(`[loader] Reloading skill: ${filename}`);
          }
          this.reloadSkill(filepath);
        }
      });
      // Combine watchers if both exist
      if (this.skillWatcher) {
        // We have both - need to close one if we create a new one
        // For now, just use the last one
        this.skillWatcher.close();
      }
      this.skillWatcher = myccWatcher;
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
   * Get all loaded tools
   */
  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all loaded skills
   */
  getSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get a skill by name
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }
}

/**
 * Create a dynamic loader instance
 */
export function createLoader(silent: boolean = false): DynamicLoader {
  return new Loader(silent);
}

/**
 * Tool loader for agent loop
 */
export class ToolLoaderImpl {
  private loader: DynamicLoader;

  constructor(loader: DynamicLoader) {
    this.loader = loader;
  }

  /**
   * Get tools formatted for Ollama API
   */
  getToolsForScope(scope: ToolScope): Tool[] {
    return this.loader
      .getTools()
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
   * Execute a tool
   */
  async execute(name: string, ctx: AgentContext, args: Record<string, unknown>): Promise<string> {
    const tool = this.loader.getTool(name);
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

/**
 * Create a tool loader
 */
export function createToolLoader(loader: DynamicLoader): ToolLoaderImpl {
  return new ToolLoaderImpl(loader);
}