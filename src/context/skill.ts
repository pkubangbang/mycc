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
   * Load all skills from directory
   */
  async loadFromDir(dir: string): Promise<void> {
    ensureDirs();

    const skillsDir = dir || getSkillsDir();

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
      return;
    }

    const files = fs.readdirSync(skillsDir);
    for (const file of files) {
      if (file.endsWith('.md')) {
        this.reloadSkill(path.join(skillsDir, file));
      }
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
    const skillsDir = getSkillsDir();

    if (this.watcher) {
      this.watcher.close();
    }

    this.watcher = watch(skillsDir, (event, filename) => {
      if (filename && filename.endsWith('.md')) {
        const filepath = path.join(skillsDir, filename);
        console.log(`[skill] Reloading: ${filename}`);
        this.reloadSkill(filepath);
      }
    });
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