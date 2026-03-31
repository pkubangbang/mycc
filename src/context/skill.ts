/**
 * skill.ts - Skill module: load skills from markdown files
 */

import * as fs from 'fs';
import * as path from 'path';
import { watch } from 'fs';
import matter from 'gray-matter';
import type { SkillModule, Skill } from '../types.js';
import { getSkillsDir, ensureDirs } from './db.js';

/**
 * Skill module implementation with hot-reload
 */
export class SkillLoader implements SkillModule {
  private skills: Map<string, Skill> = new Map();
  private watcher: fs.FSWatcher | null = null;

  /**
   * Load all skills from both project skills/ and .mycc/skills/
   */
  async loadSkills(): Promise<void> {
    ensureDirs();

    // Load from project skills/ directory
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
        console.warn(`[skill] Missing 'name' in frontmatter: ${filepath}`);
        return;
      }

      const skill: Skill = {
        name: data.name,
        description: data.description || '',
        keywords: data.keywords || [],
        content: body.trim(),
      };

      this.skills.set(skill.name, skill);
      console.log(`[skill] Loaded: ${skill.name}`);
    } catch (err) {
      console.error(`[skill] Failed to load ${filepath}:`, (err as Error).message);
    }
  }

  /**
   * Watch the skills directory for changes
   */
  watchDirectories(): void {
    const projectSkillsDir = path.join(process.cwd(), 'skills');
    const myccSkillsDir = getSkillsDir();

    // Close existing watcher if any
    if (this.watcher) {
      this.watcher.close();
    }

    // Watch project skills directory recursively
    if (fs.existsSync(projectSkillsDir)) {
      this.watcher = watch(projectSkillsDir, { recursive: true }, (event, filename) => {
        if (filename && filename.endsWith('.md')) {
          const filepath = path.join(projectSkillsDir, filename);
          console.log(`[skill] Reloading: ${filename}`);
          this.reloadSkill(filepath);
        }
      });
    }

    // Also watch .mycc/skills for runtime skills
    if (fs.existsSync(myccSkillsDir)) {
      const myccWatcher = watch(myccSkillsDir, (event, filename) => {
        if (filename && filename.endsWith('.md')) {
          const filepath = path.join(myccSkillsDir, filename);
          console.log(`[skill] Reloading: ${filename}`);
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
export function createSkill(): SkillModule {
  return new SkillLoader();
}