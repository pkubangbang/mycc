/**
 * loader.ts - Dynamic tool and skill loader with hot-reload
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { watch } from 'fs';
import matter from 'gray-matter';
import chalk from 'chalk';
import { isVerbose } from '../../config.js';

// Package root: resolve up from this file (src/context/shared/loader.ts or dist/context/shared/loader.js)
const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
import type { DynamicLoader, ToolDefinition, Skill, Tool, ToolScope, AgentContext, SkillModule, WikiModule, WikiDocument } from '../../types.js';
import { getToolsDir, getSkillsDir, getUserToolsDir, getUserSkillsDir, ensureDirs } from '../../config.js';
import { bashTool } from '../../tools/bash.js';
import { readTool } from '../../tools/read.js';
import { writeTool } from '../../tools/write.js';
import { editTool } from '../../tools/edit.js';
import { todoWriteTool } from '../../tools/todo_write.js';
import { skillLoadTool } from '../../tools/skill_load.js';
import { tmCreateTool } from '../../tools/tm_create.js';
import { tmRemoveTool } from '../../tools/tm_remove.js';
import { tmAwaitTool } from '../../tools/tm_await.js';
import { tmPrintTool } from '../../tools/tm_print.js';
import { mailToTool } from '../../tools/mail_to.js';
import { broadcastTool } from '../../tools/broadcast.js';
import { questionTool } from '../../tools/question.js';
import { briefTool } from '../../tools/brief.js';
import { issueCreateTool } from '../../tools/issue_create.js';
import { issueCloseTool } from '../../tools/issue_close.js';
import { issueCommentTool } from '../../tools/issue_comment.js';
import { issueClaimTool } from '../../tools/issue_claim.js';
import { issueListTool } from '../../tools/issue_list.js';
import { blockageCreateTool } from '../../tools/blockage_create.js';
import { blockageRemoveTool } from '../../tools/blockage_remove.js';
import { webFetchTool } from '../../tools/web_fetch.js';
import { webSearchTool } from '../../tools/web_search.js';
import { wtCreateTool } from '../../tools/wt_create.js';
import { wtRemoveTool } from '../../tools/wt_remove.js';
import { wtEnterTool } from '../../tools/wt_enter.js';
import { wtLeaveTool } from '../../tools/wt_leave.js';
import { wtPrintTool } from '../../tools/wt_print.js';
import { bgCreateTool } from '../../tools/bg_create.js';
import { bgPrintTool } from '../../tools/bg_print.js';
import { bgRemoveTool } from '../../tools/bg_remove.js';
import { bgAwaitTool } from '../../tools/bg_await.js';
import { screenTool } from '../../tools/screen.js';
import { readReadTool } from '../../tools/read-read.js';
import { readPictureTool } from '../../tools/read-picture.js';
import { wikiPrepareTool } from '../../tools/wiki_prepare.js';
import { wikiPutTool } from '../../tools/wiki_put.js';
import { wikiGetTool } from '../../tools/wiki_get.js';
import { orderTool } from '../../tools/order.js';
import { handOverTool } from '../../tools/hand_over.js';
import { gitCommitTool } from '../../tools/git_commit.js';
import { skillCompileTool } from '../../tools/skill_compile.js';

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
  readPictureTool,
  readReadTool,
  wikiPrepareTool,
  wikiPutTool,
  wikiGetTool,
  orderTool,
  handOverTool,
  gitCommitTool,
  skillCompileTool,
];

/**
 * Dynamic loader implementation
 * Implements: DynamicLoader + ToolLoader + SkillModule
 */

type Layer = 'user' | 'project' | 'built-in';

interface ToolEntry {
  tool: ToolDefinition;
  layer: Layer;
}

interface SkillEntry {
  skill: Skill;
  layer: Layer;
}

export class Loader implements DynamicLoader, SkillModule {
  private tools: Map<string, ToolEntry> = new Map();
  private skills: Map<string, SkillEntry> = new Map();
  private toolWatcher: fs.FSWatcher | null = null;
  private skillWatcher: fs.FSWatcher | null = null;
  private silent: boolean;

  constructor(silent: boolean = false) {
    this.silent = silent;
  }

  /**
   * Load all tools and skills from directories
   * Order: user → project → built-in (later overrides earlier)
   */
  async loadAll(): Promise<void> {
    ensureDirs();

    // Load in order: user → project → built-in
    // Later loads can shadow earlier ones (built-in has highest priority)
    await this.loadUserTools();
    await this.loadDynamicTools(); // project tools
    this.loadBuiltInTools();

    this.loadUserSkills();
    this.loadProjectSkills();
    this.loadBuiltInSkills();
  }

  /**
   * Load user tools from ~/.mycc-store/tools/
   */
  private async loadUserTools(): Promise<void> {
    const userToolsDir = getUserToolsDir();
    if (!fs.existsSync(userToolsDir)) {
      return;
    }

    const files = fs.readdirSync(userToolsDir);
    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        const filepath = path.join(userToolsDir, file);
        await this.loadUserTool(filepath, 'user');
      }
    }
  }

  /**
   * Load a single user tool file using async import
   */
  private async loadUserTool(filepath: string, layer: Layer): Promise<void> {
    try {
      const modulePath = pathToFileURL(filepath).href;
      const module = await import(`${modulePath}?t=${Date.now()}`);
      const tool = module.default as ToolDefinition;

      if (!tool || !tool.name) {
        if (!this.silent) {
          console.warn(chalk.yellow(`[loader] Invalid tool definition: ${filepath}`));
        }
        return;
      }

      const existing = this.tools.get(tool.name);
      if (existing && existing.layer === 'built-in') {
        if (!this.silent) {
          console.warn(chalk.yellow(`[loader] Warning: user tool '${tool.name}' cannot shadow built-in tool`));
        }
        return;
      }

      if (existing && existing.layer === 'project') {
        if (!this.silent) {
          console.warn(chalk.yellow(`[loader] Warning: user tool '${tool.name}' shadowed by project tool`));
        }
        return;
      }

      this.tools.set(tool.name, { tool, layer });
      if (isVerbose()) {
        console.log(chalk.dim(`[loader] Loaded ${layer} tool: ${tool.name}`));
      }
    } catch (err) {
      if (!this.silent) {
        console.error(chalk.red(`[loader] Failed to load user tool ${filepath}: ${(err as Error).message}`));
      }
    }
  }

  /**
   * Load built-in tools (highest priority)
   * Only logs in verbose mode since these are always loaded.
   */
  private loadBuiltInTools(): void {
    for (const tool of builtInTools) {
      // Built-in always wins
      this.tools.set(tool.name, { tool, layer: 'built-in' });
      if (isVerbose()) {
        console.log(chalk.dim(`[loader] Loaded built-in tool: ${tool.name}`));
      }
    }
  }

  /**
   * Load dynamic tools from .mycc/tools/ (project level)
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
        await this.reloadTool(path.join(toolsDir, file), true); // isInitialLoad = true
      }
    }
  }

  /**
   * Reload a single tool file (dynamic tools only - project level)
   *
   * @param filepath - Path to the tool file
   * @param isInitialLoad - If true, only log in verbose mode; if false, always log (hot-reload)
   */
  private async reloadTool(filepath: string, isInitialLoad: boolean = false): Promise<void> {
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
          console.warn(chalk.yellow(`[loader] Invalid tool definition: ${filepath}`));
        }
        return;
      }

      const existing = this.tools.get(tool.name);
      if (existing && existing.layer === 'user') {
        // Project shadows user - show warning
        if (!this.silent) {
          console.warn(chalk.yellow(`[loader] Warning: project tool '${tool.name}' shadows user tool`));
        }
      }

      // Don't override built-in
      if (existing && existing.layer === 'built-in') {
        if (!this.silent) {
          console.warn(chalk.yellow(`[loader] Warning: project tool '${tool.name}' cannot shadow built-in tool`));
        }
        return;
      }

      this.tools.set(tool.name, { tool, layer: 'project' });
      // Only show initial load logs in verbose mode; always show hot-reload logs
      if (!isInitialLoad || isVerbose()) {
        console.log(chalk.dim(`[loader] Loaded tool: ${tool.name}`));
      }
    } catch (err) {
      if (!this.silent) {
        console.error(chalk.red(`[loader] Failed to load tool ${filepath}: ${(err as Error).message}`));
      }
    }
  }

  /**
   * Load user skills from ~/.mycc/skills/
   */
  private loadUserSkills(): void {
    const userSkillsDir = getUserSkillsDir();
    if (!fs.existsSync(userSkillsDir)) {
      return;
    }
    this.loadSkillsFromDir(userSkillsDir, 'user');
  }

  /**
   * Load project skills from .mycc/skills/
   */
  private loadProjectSkills(): void {
    ensureDirs();
    const myccSkillsDir = getSkillsDir();
    this.loadSkillsFromDir(myccSkillsDir, 'project');
  }

  /**
   * Load built-in skills from skills/
   */
  private loadBuiltInSkills(): void {
    const builtInSkillsDir = path.join(packageRoot, 'skills');
    this.loadSkillsFromDir(builtInSkillsDir, 'built-in');
  }

  /**
   * Load all skills from both project skills/ and .mycc/skills/
   * @deprecated Use loadUserSkills(), loadProjectSkills(), loadBuiltInSkills() instead
   */
  loadSkills(): Promise<void> {
    this.loadUserSkills();
    this.loadProjectSkills();
    this.loadBuiltInSkills();
    return Promise.resolve();
  }

  /**
   * Load skills from a specific directory (including subdirectories)
   * Valid entrypoints:
   * - ${dir}/*.md - single file skills at root level
   * - ${dir}/${name}/SKILL.md - skill in folder structure
   */
  private loadSkillsFromDir(dir: string, layer: Layer): void {
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
      this.reloadSkill(file, layer);
    }
  }

  /**
   * Reload a single skill file
   */
  private reloadSkill(filepath: string, layer: Layer): void {
    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      const { data, content: body } = matter(content);

      if (!data.name) {
        if (!this.silent) {
          console.warn(chalk.yellow(`[loader] Missing 'name' in frontmatter: ${filepath}`));
        }
        return;
      }

      const skill: Skill = {
        name: data.name,
        description: data.description || '',
        keywords: data.keywords || [],
        content: body.trim(),
        when: data.when,  // Hook condition (natural language)
      };

      const existing = this.skills.get(skill.name);
      if (existing && existing.layer === 'user' && layer === 'project') {
        // Project shadows user - show warning
        if (!this.silent) {
          console.warn(chalk.yellow(`[loader] Warning: project skill '${skill.name}' shadows user skill`));
        }
      }

      // Don't override built-in
      if (existing && existing.layer === 'built-in') {
        if (!this.silent) {
          console.warn(chalk.yellow(`[loader] Warning: ${layer} skill '${skill.name}' cannot shadow built-in skill`));
        }
        return;
      }

      this.skills.set(skill.name, { skill, layer });
      if (!this.silent) {
        console.log(chalk.dim(`[loader] Loaded ${layer} skill: ${skill.name}`));
      }
    } catch (err) {
      if (!this.silent) {
        console.error(chalk.red(`[loader] Failed to load skill ${filepath}: ${(err as Error).message}`));
      }
    }
  }

  /**
   * Watch directories for changes (only project directories need watching)
   * - .mycc/tools/ - project tools (hot-reloadable)
   * - .mycc/skills/ - project skills (hot-reloadable)
   * Built-in tools/skills and user tools/skills are static and don't need watching.
   */
  watchDirectories(): void {
    const toolsDir = getToolsDir();
    const skillsDir = getSkillsDir();

    // Watch .mycc/tools/ for project tool changes
    if (fs.existsSync(toolsDir)) {
      this.toolWatcher = watch(toolsDir, async (event, filename) => {
        if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
          const filepath = path.join(toolsDir, filename);
          if (!this.silent) {
            console.log(chalk.dim(`[loader] Reloading tool: ${filename}`));
          }
          await this.reloadTool(filepath);
        }
      });
    }

    // Watch .mycc/skills/ for project skill changes (recursive for subdirectories)
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
              console.log(chalk.dim(`[loader] Reloading skill: ${filename}`));
            }
            this.reloadSkill(filepath, 'project');
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
    const entry = this.skills.get(name);
    return entry?.skill;
  }

  /**
   * List all skills (without content)
   * From SkillModule interface
   */
  listSkills(): Skill[] {
    return Array.from(this.skills.values()).map((entry) => ({
      name: entry.skill.name,
      description: entry.skill.description,
      keywords: entry.skill.keywords,
      content: '', // Exclude content
    }));
  }

  /**
   * Get tools formatted for Ollama API, filtered by scope
   * From merged ToolLoader interface
   */
  getToolsForScope(scope: ToolScope): Tool[] {
    return Array.from(this.tools.values())
      .filter((entry) => entry.tool.scope.includes(scope))
      .map((entry) => ({
        type: 'function' as const,
        function: {
          name: entry.tool.name,
          description: entry.tool.description,
          parameters: entry.tool.input_schema,
        },
      })) as Tool[];
  }

  /**
   * Execute a tool by name
   * From merged ToolLoader interface
   */
  async execute(name: string, ctx: AgentContext, args: Record<string, unknown>): Promise<string> {
    const entry = this.tools.get(name);
    if (!entry) {
      return `Unknown tool: ${name}`;
    }

    try {
      const result = await entry.tool.handler(ctx, args);
      return result;
    } catch (err) {
      return `Error executing ${name}: ${(err as Error).message}`;
    }
  }

  /**
   * Get scope for a skill based on its layer
   * - 'user' layer → 'user'
   * - 'project' layer → project name (from cwd)
   * - 'built-in' layer → 'built-in'
   */
  private getSkillScope(layer: Layer): string {
    if (layer === 'user') return 'user';
    if (layer === 'built-in') return 'built-in';
    // For project skills, use the project name (directory name of cwd)
    return path.basename(process.cwd());
  }

  /**
   * Index a single skill into wiki under "skills" domain
   * Content = scope + name + description + keywords (for embedding)
   */
  async indexSkillToWiki(skill: Skill, wiki: WikiModule, layer: Layer): Promise<void> {
    const scope = this.getSkillScope(layer);

    // Build content for embedding
    const keywordsStr = skill.keywords.length > 0
      ? ` Keywords: ${skill.keywords.join(', ')}`
      : '';
    const content = `Scope: ${scope}\nName: ${skill.name}\nDescription: ${skill.description}${keywordsStr}`;

    const document: WikiDocument = {
      domain: 'skills',
      title: skill.name,
      content,
      references: [],
    };

    // Check if already indexed with same content
    const existingResults = await wiki.get(skill.name, { domain: 'skills', topK: 1 });
    if (existingResults.length > 0 && existingResults[0].document.title === skill.name) {
      // Check if content matches
      if (existingResults[0].document.content === content) {
        // No change needed
        return;
      }
      // Delete old version before re-indexing
      await wiki.delete(existingResults[0].hash);
    }

    // Prepare and put
    const result = await wiki.prepare(document);
    if (result.accepted && result.hash) {
      await wiki.put(result.hash, document);
    }
  }

  /**
   * Index all skills into wiki (called by /skills build)
   */
  async indexAllSkillsToWiki(wiki: WikiModule): Promise<void> {
    // Register 'skills' domain
    await wiki.registerDomain('skills', 'Skills indexed for semantic matching');

    // Index each skill
    for (const [_name, entry] of this.skills) {
      await this.indexSkillToWiki(entry.skill, wiki, entry.layer);
    }

    console.log(chalk.dim(`[loader] Indexed ${this.skills.size} skills to wiki`));
  }

  /**
   * Get the layer (user/project/built-in) for a skill
   */
  getSkillLayer(name: string): 'user' | 'project' | 'built-in' | undefined {
    const entry = this.skills.get(name);
    return entry?.layer;
  }
}

/** Main process loader singleton */
export const loader = new Loader();
