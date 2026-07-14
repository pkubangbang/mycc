/**
 * loader.ts - Dynamic tool and skill loader with hot-reload
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { watch } from 'fs';
import { createRequire } from 'node:module';
import matter from 'gray-matter';
import { agentIO } from '../../loop/agent-io.js';
import { resolveToSkillPath, type SkillLayer } from '../../utils/skill-path-resolver.js';
import { builtInTools } from './registry.js';
import { ConditionRegistry, type Condition } from '../../hook/conditions.js';
import type { ValidationResult } from '../../hook/condition-validator.js';

/**
 * Invalidate a module from the ESM cache by its file path.
 * Uses Node.js internal module cache to remove stale entries,
 * avoiding the memory leak caused by cache-busting with ?t= query strings.
 *
 * After invalidation, the next import() of the same file will load a fresh copy.
 */
function invalidateEsmCache(filepath: string): void {
  // Access the CJS module cache — removing from this cache also affects
  // ESM dynamic imports when the file is a CommonJS or transpiled module.
  // Use createRequire (imported from node:module) which works in ESM.
  const builtinRequire = createRequire(import.meta.url);
  const Module = builtinRequire('node:module') as {
    _cache: Record<string, unknown>;
  };
  const key = pathToFileURL(path.resolve(filepath)).href;
  delete Module._cache[key];
}

/**
 * Debounce helper: returns a function that wraps the callback,
 * ensuring it only fires once within `delay` ms for the same key.
 */
function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delay: number,
): (key: string, ...args: Parameters<T>) => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return (key: string, ...args: Parameters<T>) => {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn(...args);
      }, delay),
    );
  };
}

// Package root: resolve up from this file (src/context/shared/loader.ts or dist/context/shared/loader.js)
const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
import type { DynamicLoader, ToolDefinition, Skill, Tool, ToolScope, AgentContext, SkillModule, WikiModule, WikiDocument } from '../../types.js';
import { getToolsDir, getSkillsDir, getUserToolsDir, getUserSkillsDir, ensureDirs, getMyccDir } from '../../config.js';
import * as crypto from 'crypto';
import { getEmbeddings, NAMESPACE } from '../../engine/rag-provider.js';

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
  private skillKeywords: string[] | null = null;
  /**
   * Runtime ConditionRegistry (lead process only).
   * Set via setConditionRegistry() so compileCondition() can update the
   * in-memory conditions directly instead of writing to disk and relying
   * on a broken IPC reload path. Children (silentLoader) leave this null
   * and fall back to disk + IPC.
   */
  private conditionRegistry: ConditionRegistry | null = null;

  constructor(silent: boolean = false) {
    this.silent = silent;
  }

  /**
   * Inject the runtime ConditionRegistry (lead process only).
   * Called once in agent-repl.ts after both the Loader and the runtime
   * ConditionRegistry are created. Enables compileCondition() to update
   * the in-memory condition registry directly.
   */
  setConditionRegistry(registry: ConditionRegistry): void {
    this.conditionRegistry = registry;
  }

  /**
   * Load all tools and skills from directories
   * Order: user → project → built-in (later overrides earlier)
   */
  async loadAll(): Promise<void> {
    this.skillKeywords = null; // reset keyword cache
    this.skills.clear(); // reset skills map for clean re-load
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
      invalidateEsmCache(filepath);
      const module = await import(modulePath);
      const tool = module.default as ToolDefinition;

      if (!tool || !tool.name) {
        if (!this.silent) {
          agentIO.brief('warn', 'loader', `Invalid tool definition: ${filepath}`);
        }
        return;
      }

      const existing = this.tools.get(tool.name);
      if (existing && existing.layer === 'built-in') {
        if (!this.silent) {
          agentIO.brief('warn', 'loader', `Warning: user tool '${tool.name}' cannot shadow built-in tool`);
        }
        return;
      }

      if (existing && existing.layer === 'project') {
        if (!this.silent) {
          agentIO.brief('warn', 'loader', `Warning: user tool '${tool.name}' shadowed by project tool`);
        }
        return;
      }

      this.tools.set(tool.name, { tool, layer });
      agentIO.verbose('loader', `Loaded ${layer} tool: ${tool.name}`);
    } catch (err) {
      if (!this.silent) {
        agentIO.brief('error', 'loader', `Failed to load user tool ${filepath}`, (err as Error).message);
      }
    }
  }

  /**
   * Load built-in tools (highest priority)
   * Only logs in verbose mode since these are always loaded.
   */
  private loadBuiltInTools(): void {
    for (const tool of builtInTools) {
      this.tools.set(tool.name, { tool, layer: 'built-in' });
      agentIO.verbose('loader', `Loaded built-in tool: ${tool.name}`);
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
      // Invalidate ESM cache before re-importing to get fresh module
      // without relying on cache-busting query strings which leak memory
      invalidateEsmCache(filepath);
      const modulePath = path.isAbsolute(filepath)
        ? pathToFileURL(filepath).href
        : pathToFileURL(path.resolve(filepath)).href;

      const module = await import(modulePath);
      const tool = module.default as ToolDefinition;

      if (!tool || !tool.name) {
        if (!this.silent) {
          agentIO.brief('warn', 'loader', `Invalid tool definition: ${filepath}`);
        }
        return;
      }

      const existing = this.tools.get(tool.name);
      if (existing && existing.layer === 'user') {
        // Project shadows user - show warning
        if (!this.silent) {
          agentIO.brief('warn', 'loader', `Warning: project tool '${tool.name}' shadows user tool`);
        }
      }

      // Don't override built-in
      if (existing && existing.layer === 'built-in') {
        if (!this.silent) {
          agentIO.brief('warn', 'loader', `Warning: project tool '${tool.name}' cannot shadow built-in tool`);
        }
        return;
      }

      this.tools.set(tool.name, { tool, layer: 'project' });
      // Only show initial load logs in verbose mode; always show hot-reload logs
      if (!isInitialLoad) {
        agentIO.brief('info', 'loader', `Loaded tool: ${tool.name}`);
      } else {
        agentIO.verbose('loader', `Loaded tool: ${tool.name}`);
      }
    } catch (err) {
      if (!this.silent) {
        agentIO.brief('error', 'loader', `Failed to load tool ${filepath}`, (err as Error).message);
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
    this.skillKeywords = null; // reset keyword cache
    this.skills.clear(); // reset skills map for clean re-load
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
          agentIO.brief('warn', 'loader', `Missing 'name' in frontmatter: ${filepath}`);
        }
        return;
      }

      // Convert layer to SkillLayer type for resolver
      const skillLayer: SkillLayer = layer === 'built-in' ? 'built-in' : layer;

      // Resolve to skill path notation using the utility
      const sourceFile = resolveToSkillPath(filepath, skillLayer);
      if (!sourceFile) {
        if (!this.silent) {
          agentIO.brief('warn', 'loader', `Invalid skill path format: ${filepath}`);
        }
        return;
      }

      // Normalize keywords: YAML can parse "tag1, tag2" as string, not array
      let keywords: string[];
      if (Array.isArray(data.keywords)) {
        keywords = data.keywords.map((k: unknown) => String(k).trim());
      } else if (typeof data.keywords === 'string' && data.keywords.trim()) {
        keywords = data.keywords.split(',').map((k: string) => k.trim()).filter(Boolean);
      } else {
        keywords = [];
      }

      const skill: Skill = {
        name: data.name,
        description: data.description || '',
        keywords,
        content: body.trim(),
        when: data.when,  // Hook condition (natural language)
        sourceFile,  // Track source file for orphan detection (format: "layer:path")
      };

      const existing = this.skills.get(skill.name);
      if (existing && existing.layer === 'user' && layer === 'project') {
        // Project shadows user - show warning
        if (!this.silent) {
          agentIO.brief('warn', 'loader', `Warning: project skill '${skill.name}' shadows user skill`);
        }
      }

      // Don't override built-in
      if (existing && existing.layer === 'built-in') {
        if (!this.silent) {
          agentIO.brief('warn', 'loader', `Warning: ${layer} skill '${skill.name}' cannot shadow built-in skill`);
        }
        return;
      }

      this.skills.set(skill.name, { skill, layer });
      if (!this.silent) {
        agentIO.verbose('loader', `Loaded ${layer} skill: ${skill.name}`);
      }
    } catch (err) {
      if (!this.silent) {
        agentIO.brief('error', 'loader', `Failed to load skill ${filepath}`, (err as Error).message);
      }
    }
  }

  /**
   * Watch directories for changes (only project directories need watching)
   * - .mycc/tools/ - project tools (hot-reloadable)
   * - .mycc/skills/ - project skills (hot-reloadable)
   * Built-in tools/skills and user tools/skills are static and don't need watching.
   *
   * Re-entry safe: closes any existing watchers before creating new ones.
   */
  watchDirectories(): void {
    // Close any existing watchers first (re-entry safe)
    this.stopWatching();

    const toolsDir = getToolsDir();
    const skillsDir = getSkillsDir();

    // Debounce tool reloads — fs.watch can fire multiple events per save
    const debouncedReloadTool = debounce(
      (filepath: string) => {
        void this.reloadTool(filepath);
      },
      300,
    );

    // Debounce skill reloads
    const debouncedReloadSkill = debounce(
      (filepath: string) => {
        this.reloadSkill(filepath, 'project');
      },
      300,
    );

    // Watch .mycc/tools/ for project tool changes
    if (fs.existsSync(toolsDir)) {
      this.toolWatcher = watch(toolsDir, (_event, filename) => {
        if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
          const filepath = path.join(toolsDir, filename);
          if (!this.silent) {
            agentIO.verbose('loader', `Reloading tool: ${filename}`);
          }
          debouncedReloadTool(filepath, filepath);
        }
      });
    }

    // Watch .mycc/skills/ for project skill changes (recursive for subdirectories)
    if (fs.existsSync(skillsDir)) {
      this.skillWatcher = watch(skillsDir, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.md')) {
          // Only load valid entrypoints:
          // - Root level: any *.md file
          // - Subdirectories: only SKILL.md
          const isRootLevel = !filename.includes(path.sep);
          const isSkillEntrypoint = filename.endsWith(path.join(path.sep, 'SKILL.md'));

          if (isRootLevel || isSkillEntrypoint) {
            const filepath = path.join(skillsDir, filename);
            if (!this.silent) {
              agentIO.verbose('loader', `Reloading skill: ${filename}`);
            }
            debouncedReloadSkill(filepath, filepath);
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
   * 
   * @deprecated the return values should NOT be used by llm directly
   * because it may overflow the ctx.
   */
  listSkills(): Skill[] {
    return Array.from(this.skills.values()).map((entry) => ({
      name: entry.skill.name,
      description: entry.skill.description,
      keywords: entry.skill.keywords,
      when: entry.skill.when,
      content: '', // Exclude content
    }));
  }

  /**
   * Get deduplicated, sorted list of all skill keywords.
   * Result is cached per load cycle — reset when loadAll() is called.
   */
  getSkillKeywords(): string[] {
    if (this.skillKeywords === null) {
      const allKeywords = new Set<string>();
      for (const [, entry] of this.skills) {
        for (const kw of entry.skill.keywords) {
          allKeywords.add(kw);
        }
      }
      this.skillKeywords = [...allKeywords].sort();
    }
    return this.skillKeywords;
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
  async execute(name: string, ctx: AgentContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const entry = this.tools.get(name);
    if (!entry) {
      return `Unknown tool: ${name}`;
    }

    try {
      const result = await entry.tool.handler(ctx, args, signal);
      return result;
    } catch (err) {
      return `Error executing ${name}: ${(err as Error).message}`;
    }
  }

  /**
   * List all available tools with name and description
   * Used for condition compilation to validate trigger tool names
   */
  listAllTools(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map((entry) => ({
      name: entry.tool.name,
      description: entry.tool.description,
    }));
  }

  /**
   * Compile a skill's "when" condition into a structured hook and update the
   * runtime condition registry so the hook system picks it up immediately.
   *
   * Lineage: conditions are the compiled form of a skill's "when" field, so
   * the Loader (skill manager) owns condition compilation. This replaces
   * the old approach where skill_compile created a throwaway
   * ConditionRegistry and sent a broken IPC message that the Coordinator
   * silently dropped.
   *
   * Lead process: compiles directly on the runtime ConditionRegistry, which
   * atomically calls .set() (in-memory update) and .save() (disk persist).
   * No IPC, no restart needed.
   *
   * Child process (silentLoader, conditionRegistry === null): compiles to a
   * temporary registry that persists to disk, then sends a 'condition_replace'
   * IPC message to the Lead so its runtime registry reloads from disk.
   *
   * @returns The compile result (condition + validation + error), mirroring
   *          ConditionRegistry.compile()'s return shape.
   */
  async compileCondition(
    skillName: string,
    feedback?: string,
  ): Promise<{ condition?: Condition; validation?: ValidationResult; error?: string }> {
    const skill = this.getSkill(skillName);
    if (!skill) {
      return { error: `Skill '${skillName}' not found.` };
    }
    if (!skill.when) {
      // Caller (skill_compile tool) handles the "no when field" case with a
      // lookup of any existing compiled condition. We only report the missing
      // field so the caller can present the existing condition if present.
      return { error: `Skill '${skillName}' has no "when" field. Only skills with "when" conditions can be compiled.` };
    }

    const availableTools = this.listAllTools();
    const sourceFile = skill.sourceFile;

    // Build skill content for the compiler. When feedback is provided
    // (refinement of an existing condition), fold it into the content so
    // the LLM sees the user's correction guidance during compilation.
    const compileContent = feedback
      ? `${skill.content}\n\n--- Refinement feedback ---\n${feedback}`
      : skill.content;

    // Lead process: compile directly on the runtime registry. compile()
    // atomically calls .set() (in-memory update) and .save() (disk persist),
    // so the hook system picks up the new condition immediately — no IPC,
    // no restart needed.
    if (this.conditionRegistry) {
      const existing = this.conditionRegistry.get(skillName);
      return await this.conditionRegistry.compile(
        skill.when,
        skillName,
        compileContent,
        existing,
        sourceFile,
        availableTools,
      );
    }

    // Child process: compile to a temporary registry that persists to disk,
    // then send a 'condition_replace' IPC message so the Lead reloads its
    // runtime registry from disk. The Coordinator forwards this message
    // type to the Lead (handled by ParentContext.initializeIpcHandlers()).
    const tempRegistry = new ConditionRegistry();
    const loadResult = await tempRegistry.load();
    for (const error of loadResult.errors) {
      agentIO.brief('error', 'loader', `Condition load error: ${error}`);
    }
    for (const warning of loadResult.warnings) {
      agentIO.brief('warn', 'loader', `Condition load warning: ${warning}`);
    }
    const existing = tempRegistry.get(skillName);
    const result = await tempRegistry.compile(
      skill.when,
      skillName,
      compileContent,
      existing,
      sourceFile,
      availableTools,
    );

    // Persist succeeded → ask the Lead to reload its runtime registry from disk
    if (!result.error && process.send) {
      process.send({ type: 'condition_replace', skillName });
    }
    return result;
  }

  /**
   * Reload the compiled condition for a skill from disk into the runtime
   * ConditionRegistry. Used by the 'condition_replace' IPC handler so that
   * a teammate's compileCondition() (which writes to disk in the child) is
   * picked up by the Lead's in-memory registry without a restart.
   *
   * No-op (returns error) when conditionRegistry is null (child process).
   */
  async replaceCondition(
    skillName: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.conditionRegistry) {
      return { success: false, error: 'Condition registry not available (child process)' };
    }
    // Reload all conditions from disk — load() validates and atomically
    // replaces the in-memory map from conditions.json, which the child
    // already wrote to via its temporary registry.
    const loadResult = await this.conditionRegistry.load();
    if (loadResult.errors.length > 0) {
      return { success: false, error: loadResult.errors.join('; ') };
    }
    if (!this.conditionRegistry.get(skillName)) {
      return { success: false, error: `Condition '${skillName}' not found after reload` };
    }
    return { success: true };
  }

  /**
   * Get scope for a skill based on its layer
   * - 'user' layer → '[user]'
   * - 'project' layer → project name (from cwd)
   * - 'built-in' layer → '[built-in]'
   */
  private getSkillScope(layer: Layer): string {
    if (layer === 'user') return '[user]';
    if (layer === 'built-in') return '[built-in]';
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
      title: `${scope}:${skill.name}`,
      content,
      references: [],
    };

    // Check if already indexed with same content
    const expectedTitle = `${scope}:${skill.name}`;
    const existingResults = await wiki.get(skill.name, { domain: 'skills', topK: 1 });
    if (existingResults.length > 0 && existingResults[0].document.title === expectedTitle) {
      // Check if content matches
      if (existingResults[0].document.content === content) {
        // No change needed
        return;
      }
      // Delete old version before re-indexing
      await wiki.delete(existingResults[0].hash);
    }

    // Prepare and put (skip duplicate embedding check — title de-duplication is sufficient for skills)
    const result = await wiki.prepare(document, true);
    if (result.accepted && result.hash) {
      await wiki.put(result.hash, document);
    }
  }

  /**
   * Build the WikiDocument that represents a skill in the wiki "skills" domain.
   * The content (Scope + Name + Description + Keywords) is what gets embedded.
   */
  private buildSkillDocument(skill: Skill, layer: Layer): WikiDocument {
    const scope = this.getSkillScope(layer);
    const keywordsStr = skill.keywords.length > 0
      ? ` Keywords: ${skill.keywords.join(', ')}`
      : '';
    const content = `Scope: ${scope}\nName: ${skill.name}\nDescription: ${skill.description}${keywordsStr}`;
    return {
      domain: 'skills',
      title: `${scope}:${skill.name}`,
      content,
      references: [],
    };
  }

  /**
   * Path to the skill-index cache file (under project .mycc/, gitignored).
   * The cache stores a snapshot of every indexed skill's title→content hash
   * plus the RAG namespace, so unchanged skills can be skipped on restart.
   */
  private getSkillIndexCachePath(): string {
    return path.join(getMyccDir(), 'skill-index-cache.json');
  }

  /**
   * Compute a stable short hash for a skill's wiki content string.
   * Used as the cache value (content→hash) so we can compare without
   * storing full content blobs in the cache file.
   */
  private hashSkillContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Index all skills into wiki (called at startup and by /skills build).
   *
   * Optimized to avoid the per-skill Ollama round-trips that previously made
   * this step block startup:
   *  1. Cache check — if every skill's content hash matches the on-disk
   *     snapshot (and the RAG namespace is unchanged), skip indexing entirely.
   *  2. Batch path — one table scan (getByDomain, 0 embeddings), an in-memory
   *     diff, ONE batched embedding call (getEmbeddings) for changed/new
   *     skills, batch delete of stale records, and ONE batchPut insert.
   */
  async indexAllSkillsToWiki(wiki: WikiModule): Promise<void> {
    // Register 'skills' domain
    await wiki.registerDomain('skills', 'Skills indexed for semantic matching');

    // Build the full set of skill documents + per-skill content hashes in memory
    const entries: Array<{ document: WikiDocument; layer: Layer; contentHash: string }> = [];
    for (const [, skillEntry] of this.skills) {
      const document = this.buildSkillDocument(skillEntry.skill, skillEntry.layer);
      entries.push({
        document,
        layer: skillEntry.layer,
        contentHash: this.hashSkillContent(document.content),
      });
    }

    // ── Optimization 0: cache check ──
    // If the on-disk cache matches every skill (title→contentHash) and the
    // RAG namespace is unchanged, skip the whole indexing pass — nothing to do.
    if (this.isSkillIndexCacheValid(entries)) {
      agentIO.brief('info', 'loader', `Indexed ${this.skills.size} skills to wiki (cached)`);
      return;
    }

    // ── Optimization 1: batch path ──
    // One table scan for all existing 'skills' records (no embeddings).
    const existing = await wiki.getByDomain('skills');
    const existingByTitle = new Map<string, { hash: string; content: string }>();
    for (const r of existing) {
      existingByTitle.set(r.document.title, { hash: r.hash, content: r.document.content });
    }

    // In-memory diff: partition into unchanged / stale / new
    const toDelete: string[] = [];
    const toAdd: WikiDocument[] = [];
    for (const { document } of entries) {
      const found = existingByTitle.get(document.title);
      if (found && found.content === document.content) {
        continue; // unchanged
      }
      if (found) {
        toDelete.push(found.hash); // content changed → delete old before re-add
      }
      toAdd.push(document);
    }
    // Detect orphaned existing records (titles no longer present) and delete them.
    //
    // IMPORTANT: the wiki DB is shared across ALL projects (it lives in
    // ~/.mycc-store/wiki, not under the project). Skill record titles are
    // prefixed with their scope — `[user]:`, `[built-in]:`, or
    // `<project-basename>:`. A record written by project A therefore has a
    // title prefix project B cannot match, so it must NOT be treated as an
    // orphan by project B — otherwise two projects would mutually wipe each
    // other's project-scoped skill records on every startup.
    //
    // Only records whose title prefix is in THIS project's own scope set
    // ([user], [built-in], and the current project basename) are eligible for
    // orphan deletion. Records from other projects are left untouched.
    const projectName = path.basename(process.cwd());
    const ownScopePrefixes = new Set(['[user]:', '[built-in]:', `${projectName}:`]);
    const isOwnScope = (title: string): boolean => {
      for (const prefix of ownScopePrefixes) {
        if (title.startsWith(prefix)) return true;
      }
      return false;
    };
    const currentTitles = new Set(entries.map((e) => e.document.title));
    for (const [title, rec] of existingByTitle) {
      if (currentTitles.has(title)) continue; // still present
      if (!isOwnScope(title)) continue; // belongs to another project — leave it
      toDelete.push(rec.hash);
    }

    // Batch embed all new/changed documents in ONE Ollama call
    let embeddings: number[][] = [];
    if (toAdd.length > 0) {
      embeddings = await getEmbeddings(
        toAdd.map((d) => d.content),
        'document',
      );
    }

    // Batch delete stale/orphaned records
    for (const hash of toDelete) {
      await wiki.delete(hash);
    }

    // Batch insert all new/changed documents in ONE table.add() call
    if (toAdd.length > 0) {
      const batchEntries = toAdd.map((document, i) => ({ document, embedding: embeddings[i] }));
      await wiki.batchPut(batchEntries);
    }

    // Write the cache so the next startup can skip if nothing changed
    this.writeSkillIndexCache(entries);

    agentIO.brief('info', 'loader', `Indexed ${this.skills.size} skills to wiki`);
  }

  /**
   * Read the on-disk skill-index cache and return whether it covers every
   * current skill with a matching content hash, under the same RAG namespace.
   */
  private isSkillIndexCacheValid(
    entries: Array<{ document: WikiDocument; contentHash: string }>,
  ): boolean {
    const cachePath = this.getSkillIndexCachePath();
    if (!fs.existsSync(cachePath)) return false;

    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      const cache = JSON.parse(raw) as {
        namespace?: string;
        skills?: Record<string, string>;
      };

      // Namespace change (embedding model swap) invalidates the cache —
      // vectors live in a different LanceDB table.
      if (cache.namespace !== NAMESPACE) return false;
      if (!cache.skills) return false;

      // Every current skill must be present with a matching content hash
      const cached = cache.skills;
      if (Object.keys(cached).length !== entries.length) return false;
      for (const { document, contentHash } of entries) {
        if (cached[document.title] !== contentHash) return false;
      }
      return true;
    } catch {
      return false; // corrupt cache → treat as miss
    }
  }

  /**
   * Persist the skill-index cache snapshot to disk.
   */
  private writeSkillIndexCache(
    entries: Array<{ document: WikiDocument; contentHash: string }>,
  ): void {
    try {
      ensureDirs();
      const cachePath = this.getSkillIndexCachePath();
      const skills: Record<string, string> = {};
      for (const { document, contentHash } of entries) {
        skills[document.title] = contentHash;
      }
      const cache = { namespace: NAMESPACE, skills };
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {
      // Cache write failure is non-fatal — indexing already succeeded.
    }
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