/**
 * skill-path-resolver.ts - Cross-platform skill path resolution
 *
 * Skills can be stored in three locations:
 * - User folder: ~/.mycc-store/skills/
 * - Project folder: .mycc/skills/
 * - Built-in folder: <package_root>/skills/
 *
 * Skill paths use a notation: "{layer}:{path}"
 * - layer: "user", "project", or "built-in"
 * - path: either "{name}.md" or "{name}/SKILL.md"
 *
 * Examples:
 * - "user:my-skill.md" -> ~/.mycc-store/skills/my-skill.md
 * - "project:code-review/SKILL.md" -> .mycc/skills/code-review/SKILL.md
 * - "built-in:git-workflow/SKILL.md" -> <package_root>/skills/git-workflow/SKILL.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getMyccDir } from '../config.js';

/**
 * Skill layer (where the skill is stored)
 */
export type SkillLayer = 'user' | 'project' | 'built-in';

/**
 * Parsed skill path
 */
export interface ParsedSkillPath {
  layer: SkillLayer;
  skillName: string;      // The skill name (from frontmatter, not filename)
  filename: string;       // The file name: "skill.md" or "SKILL.md"
  relativePath: string;   // Full relative path from layer base dir
  absolutePath: string;   // Absolute path to the skill file
}

// Cache for package root (computed once)
let packageRoot: string | null = null;

/**
 * Get the package root directory (where package.json and src/ are located)
 */
export function getPackageRoot(): string {
  if (packageRoot) {
    return packageRoot;
  }
  // This file is at src/utils/skill-path-resolver.ts
  // Package root is 2 levels up from dist/utils/ or 3 levels up from src/utils/
  const currentDir = __dirname;
  // Check if we're in dist/ (compiled) or src/ (typescript)
  if (currentDir.includes(`${path.sep}dist${path.sep}`)) {
    packageRoot = path.resolve(currentDir, '..', '..');
  } else {
    packageRoot = path.resolve(currentDir, '..', '..');
  }
  return packageRoot;
}

/**
 * Get the base directory for a skill layer
 */
export function getLayerBaseDir(layer: SkillLayer): string {
  switch (layer) {
    case 'user':
      return path.join(os.homedir(), '.mycc-store', 'skills');
    case 'project':
      return path.join(getMyccDir(), 'skills');
    case 'built-in':
      return path.join(getPackageRoot(), 'skills');
  }
}

/**
 * Parse a skill path notation into its components
 *
 * @param skillPath - Skill path in notation: "layer:relativePath"
 * @returns Parsed skill path, or null if invalid
 *
 * @example
 * parseSkillPath("user:my-skill.md") // { layer: "user", relativePath: "my-skill.md", ... }
 * parseSkillPath("project:code-review/SKILL.md") // { layer: "project", relativePath: "code-review/SKILL.md", ... }
 */
export function parseSkillPath(skillPath: string): ParsedSkillPath | null {
  // Find the colon separator
  const colonIndex = skillPath.indexOf(':');
  if (colonIndex === -1) {
    return null;
  }

  const layerStr = skillPath.substring(0, colonIndex);
  const relativePath = skillPath.substring(colonIndex + 1);

  // Validate layer
  let layer: SkillLayer;
  if (layerStr === 'user') {
    layer = 'user';
  } else if (layerStr === 'project') {
    layer = 'project';
  } else if (layerStr === 'built-in') {
    layer = 'built-in';
  } else {
    return null;
  }

  // Validate relative path format
  if (!isValidSkillRelativePath(relativePath)) {
    return null;
  }

  // Extract skill name and filename
  const parts = relativePath.split('/');
  const filename = parts[parts.length - 1];
  let skillName: string;

  if (parts.length === 1) {
    // Direct child: "skill.md" -> skill name is filename without extension
    skillName = filename.replace(/\.md$/i, '');
  } else {
    // Subdirectory: "skill-dir/SKILL.md" -> skill name is the directory name
    skillName = parts[parts.length - 2];
  }

  const baseDir = getLayerBaseDir(layer);
  const absolutePath = path.join(baseDir, relativePath);

  return {
    layer,
    skillName,
    filename,
    relativePath,
    absolutePath,
  };
}

/**
 * Create a skill path notation from layer and relative path
 *
 * @param layer - Skill layer
 * @param relativePath - Relative path from layer base directory
 * @returns Skill path notation
 */
export function formatSkillPath(layer: SkillLayer, relativePath: string): string {
  return `${layer}:${relativePath}`;
}

/**
 * Validate a skill relative path
 * Must be either:
 * - A direct child markdown file: "skill.md"
 * - A SKILL.md under a subdirectory: "subdir/SKILL.md"
 *
 * @param relativePath - Relative path to validate
 * @returns true if valid
 */
export function isValidSkillRelativePath(relativePath: string): boolean {
  // Normalize path separators
  const normalized = relativePath.replace(/\\/g, '/');

  // Check for path traversal attempts
  if (normalized.includes('..') || normalized.startsWith('/')) {
    return false;
  }

  const parts = normalized.split('/');

  // Must end with .md
  const filename = parts[parts.length - 1];
  if (!filename.toLowerCase().endsWith('.md')) {
    return false;
  }

  // Valid formats:
  // 1. Direct child: "skill.md" (single part)
  // 2. Subdirectory with SKILL.md: "subdir/SKILL.md" (two parts, second is SKILL.md)
  if (parts.length === 1) {
    // Direct child: any .md file is valid
    return true;
  } else if (parts.length === 2) {
    // Must be "something/SKILL.md"
    return filename.toLowerCase() === 'skill.md';
  } else {
    // Nested paths are not allowed
    return false;
  }
}

/**
 * Check if a skill file exists at the given path
 *
 * @param skillPath - Skill path in notation
 * @returns true if file exists
 */
export function skillFileExists(skillPath: string): boolean {
  const parsed = parseSkillPath(skillPath);
  if (!parsed) {
    return false;
  }

  try {
    return fs.existsSync(parsed.absolutePath);
  } catch {
    return false;
  }
}

/**
 * Resolve a raw file path to skill path notation
 * Used when loading skills to create the sourceFile property
 *
 * @param filePath - Absolute or relative file path
 * @param layer - Which layer this file belongs to
 * @returns Skill path notation, or null if invalid
 */
export function resolveToSkillPath(filePath: string, layer: SkillLayer): string | null {
  const baseDir = getLayerBaseDir(layer);
  
  // Compute relative path
  let relativePath: string;
  try {
    relativePath = path.relative(baseDir, filePath);
  } catch {
    return null;
  }

  // Normalize separators
  relativePath = relativePath.replace(/\\/g, '/');

  // Validate the path format
  if (!isValidSkillRelativePath(relativePath)) {
    return null;
  }

  return formatSkillPath(layer, relativePath);
}

/**
 * Get the absolute path for a skill
 *
 * @param skillPath - Skill path in notation
 * @returns Absolute file path, or null if invalid
 */
export function getSkillAbsolutePath(skillPath: string): string | null {
  const parsed = parseSkillPath(skillPath);
  return parsed?.absolutePath ?? null;
}

/**
 * Check if a string is a valid skill path notation
 *
 * @param skillPath - String to check
 * @returns true if valid skill path notation
 */
export function isSkillPath(skillPath: string): boolean {
  return parseSkillPath(skillPath) !== null;
}

/**
 * Get layer from skill path
 *
 * @param skillPath - Skill path in notation
 * @returns Layer or null if invalid
 */
export function getSkillLayer(skillPath: string): SkillLayer | null {
  const parsed = parseSkillPath(skillPath);
  return parsed?.layer ?? null;
}