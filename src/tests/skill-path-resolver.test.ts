/**
 * Tests for skill-path-resolver.ts
 */

import { describe, it, expect } from 'vitest';
import {
  parseSkillPath,
  formatSkillPath,
  isValidSkillRelativePath,
  getSkillAbsolutePath,
  isSkillPath,
  getSkillLayer,
  type SkillLayer,
} from '../utils/skill-path-resolver.js';

describe('skill-path-resolver', () => {
  describe('isValidSkillRelativePath', () => {
    it('should accept direct child markdown files', () => {
      expect(isValidSkillRelativePath('my-skill.md')).toBe(true);
      expect(isValidSkillRelativePath('code-review.md')).toBe(true);
      expect(isValidSkillRelativePath('git_workflow.md')).toBe(true);
    });

    it('should accept SKILL.md under subdirectory', () => {
      expect(isValidSkillRelativePath('my-skill/SKILL.md')).toBe(true);
      expect(isValidSkillRelativePath('code-review/SKILL.md')).toBe(true);
      expect(isValidSkillRelativePath('a/SKILL.md')).toBe(true);
    });

    it('should reject nested paths', () => {
      expect(isValidSkillRelativePath('a/b/SKILL.md')).toBe(false);
      expect(isValidSkillRelativePath('deep/nested/path/SKILL.md')).toBe(false);
    });

    it('should reject non-markdown files', () => {
      expect(isValidSkillRelativePath('my-skill.txt')).toBe(false);
      expect(isValidSkillRelativePath('my-skill.js')).toBe(false);
    });

    it('should reject path traversal attempts', () => {
      expect(isValidSkillRelativePath('../my-skill.md')).toBe(false);
      expect(isValidSkillRelativePath('my-skill/../other.md')).toBe(false);
      expect(isValidSkillRelativePath('/absolute/path.md')).toBe(false);
    });

    it('should reject files that are not SKILL.md in subdirectories', () => {
      expect(isValidSkillRelativePath('my-skill/other.md')).toBe(false);
      expect(isValidSkillRelativePath('my-skill/readme.md')).toBe(false);
    });

    it('should handle case-insensitive SKILL.md', () => {
      // SKILL.md should be case-sensitive
      expect(isValidSkillRelativePath('my-skill/SKILL.md')).toBe(true);
      expect(isValidSkillRelativePath('my-skill/skill.md')).toBe(true); // lowercase is also valid
      expect(isValidSkillRelativePath('my-skill/Skill.md')).toBe(true); // mixed case is also valid
    });
  });

  describe('parseSkillPath', () => {
    it('should parse user layer skill paths', () => {
      const result = parseSkillPath('user:my-skill.md');
      expect(result).not.toBeNull();
      expect(result?.layer).toBe('user');
      expect(result?.relativePath).toBe('my-skill.md');
      expect(result?.skillName).toBe('my-skill');
      expect(result?.filename).toBe('my-skill.md');
    });

    it('should parse project layer skill paths', () => {
      const result = parseSkillPath('project:code-review/SKILL.md');
      expect(result).not.toBeNull();
      expect(result?.layer).toBe('project');
      expect(result?.relativePath).toBe('code-review/SKILL.md');
      expect(result?.skillName).toBe('code-review');
      expect(result?.filename).toBe('SKILL.md');
    });

    it('should parse built-in layer skill paths', () => {
      const result = parseSkillPath('built-in:git-workflow/SKILL.md');
      expect(result).not.toBeNull();
      expect(result?.layer).toBe('built-in');
      expect(result?.relativePath).toBe('git-workflow/SKILL.md');
    });

    it('should reject invalid layer', () => {
      expect(parseSkillPath('invalid:my-skill.md')).toBeNull();
      expect(parseSkillPath('unknown:my-skill.md')).toBeNull();
    });

    it('should reject invalid path format', () => {
      expect(parseSkillPath('user:nested/path/SKILL.md')).toBeNull();
      expect(parseSkillPath('project:../traversal.md')).toBeNull();
    });

    it('should reject missing colon', () => {
      expect(parseSkillPath('my-skill.md')).toBeNull();
      expect(parseSkillPath('usermy-skill.md')).toBeNull();
    });

    it('should provide absolute paths', () => {
      const result = parseSkillPath('user:my-skill.md');
      expect(result?.absolutePath).toContain('.mycc-store');
      expect(result?.absolutePath).toContain('skills');
      expect(result?.absolutePath).toContain('my-skill.md');
    });
  });

  describe('formatSkillPath', () => {
    it('should format user skill paths', () => {
      expect(formatSkillPath('user', 'my-skill.md')).toBe('user:my-skill.md');
    });

    it('should format project skill paths', () => {
      expect(formatSkillPath('project', 'code-review/SKILL.md')).toBe('project:code-review/SKILL.md');
    });

    it('should format built-in skill paths', () => {
      expect(formatSkillPath('built-in', 'git-workflow/SKILL.md')).toBe('built-in:git-workflow/SKILL.md');
    });
  });

  describe('isSkillPath', () => {
    it('should return true for valid skill paths', () => {
      expect(isSkillPath('user:my-skill.md')).toBe(true);
      expect(isSkillPath('project:code-review/SKILL.md')).toBe(true);
      expect(isSkillPath('built-in:git-workflow/SKILL.md')).toBe(true);
    });

    it('should return false for invalid skill paths', () => {
      expect(isSkillPath('invalid:my-skill.md')).toBe(false);
      expect(isSkillPath('my-skill.md')).toBe(false);
      expect(isSkillPath('user:nested/deep/SKILL.md')).toBe(false);
    });
  });

  describe('getSkillLayer', () => {
    it('should extract layer from valid paths', () => {
      expect(getSkillLayer('user:my-skill.md')).toBe('user');
      expect(getSkillLayer('project:my-skill.md')).toBe('project');
      expect(getSkillLayer('built-in:my-skill.md')).toBe('built-in');
    });

    it('should return null for invalid paths', () => {
      expect(getSkillLayer('invalid:my-skill.md')).toBeNull();
      expect(getSkillLayer('my-skill.md')).toBeNull();
    });
  });

  describe('getSkillAbsolutePath', () => {
    it('should return absolute path for valid skill paths', () => {
      const path = getSkillAbsolutePath('user:my-skill.md');
      expect(path).not.toBeNull();
      expect(path).toContain('.mycc-store');
      expect(path).toContain('my-skill.md');
    });

    it('should return null for invalid paths', () => {
      expect(getSkillAbsolutePath('invalid:my-skill.md')).toBeNull();
      expect(getSkillAbsolutePath('my-skill.md')).toBeNull();
    });
  });
});