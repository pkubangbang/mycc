/**
 * skill.ts - Skill module: load skills from markdown files
 */

import * as fs from 'fs';
import * as path from 'path';
import { watch } from 'fs';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import type { SkillModule, Skill } from '../types.js';
import { getSkillsDir, ensureDirs } from './db.js';

// Get the directory of this module (works for both source and compiled)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Skill module implementation with hot-reload
 */
export class SkillLoader implements SkillModule {
  private skills: Map<string, Skill> = new Map();
  private watcher: fs.FSWatcher | null = null;
  private silent: boolean;

  constructor(silent: boolean = false) {
    this.silent = silent;
  }

  /**
   * Load all skills from both project skills/ and .mycc/skills/
   */
  async loadSkills(): Promise<void> {
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
          console.warn(`[skill] Missing 'name' in frontmatter: ${filepath}`);
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
        console.log(`[skill] Loaded: ${skill.name}`);
      }
    } catch (err) {
      if (!this.silent) {
        console.error(`[skill] Failed to load ${filepath}:`, (err as Error).message);
      }
    }
  }

  /**
   * Watch the skills directory for changes
   */
  watchDirectories(): void {
    const builtInSkillsDir = path.join(__dirname, '..', '..', 'skills');
    const projectSkillsDir = path.join(process.cwd(), 'skills');
    const myccSkillsDir = getSkillsDir();

    // Close existing watcher if any
    if (this.watcher) {
      this.watcher.close();
    }

    // Watch built-in skills directory recursively
    if (fs.existsSync(builtInSkillsDir)) {
      this.watcher = watch(builtInSkillsDir, { recursive: true }, (event, filename) => {
        if (filename && filename.endsWith('.md')) {
          const filepath = path.join(builtInSkillsDir, filename);
          if (!this.silent) {
            console.log(`[skill] Reloading: ${filename}`);
          }
          this.reloadSkill(filepath);
        }
      });
    }

    // Watch project skills directory recursively
    if (fs.existsSync(projectSkillsDir)) {
      const projectWatcher = watch(projectSkillsDir, { recursive: true }, (event, filename) => {
        if (filename && filename.endsWith('.md')) {
          const filepath = path.join(projectSkillsDir, filename);
          if (!this.silent) {
            console.log(`[skill] Reloading: ${filename}`);
          }
          this.reloadSkill(filepath);
        }
      });
      // Note: this will replace the built-in watcher if both exist
      // For a proper solution, we'd need to manage multiple watchers
    }

    // Also watch .mycc/skills for runtime skills
    if (fs.existsSync(myccSkillsDir)) {
      const myccWatcher = watch(myccSkillsDir, (event, filename) => {
        if (filename && filename.endsWith('.md')) {
          const filepath = path.join(myccSkillsDir, filename);
          if (!this.silent) {
            console.log(`[skill] Reloading: ${filename}`);
          }
          this.reloadSkill(filepath);
        }
      });
      // Note: this will replace the project watcher if both exist
      // For a proper solution, we'd need to manage multiple watchers
    }
  }

  /**
   * Stop watching
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * List all skills (without content)
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
   * Get a skill by name (with full content)
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }
}

/**
 * Create a skill module instance
 */
export function createSkill(silent: boolean = false): SkillModule {
  return new SkillLoader(silent);
}