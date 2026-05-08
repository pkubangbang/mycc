/**
 * Tests for skill-path-resolver.ts
 * Only tests the exported public API
 */

import { describe, it, expect } from 'vitest';
import {
  getSkillAbsolutePath,
  resolveToSkillPath,
  type SkillLayer,
} from '../utils/skill-path-resolver.js';
import path from 'path';
import os from 'os';

describe('skill-path-resolver', () => {
  describe('getSkillAbsolutePath', () => {
    it('should return absolute path for valid user skill paths', () => {
      const result = getSkillAbsolutePath('user:my-skill.md');
      expect(result).not.toBeNull();
      expect(result).toContain('.mycc-store');
      expect(result).toContain('my-skill.md');
    });

    it('should return absolute path for valid project skill paths', () => {
      const result = getSkillAbsolutePath('project:code-review/SKILL.md');
      expect(result).not.toBeNull();
      expect(result).toContain('code-review');
      expect(result).toContain('SKILL.md');
    });

    it('should return absolute path for valid built-in skill paths', () => {
      const result = getSkillAbsolutePath('built-in:git-workflow/SKILL.md');
      expect(result).not.toBeNull();
      expect(result).toContain('git-workflow');
      expect(result).toContain('SKILL.md');
    });

    it('should return null for invalid paths', () => {
      expect(getSkillAbsolutePath('invalid:my-skill.md')).toBeNull();
      expect(getSkillAbsolutePath('my-skill.md')).toBeNull();
      expect(getSkillAbsolutePath('user:nested/deep/SKILL.md')).toBeNull();
    });

    it('should reject paths with traversal', () => {
      expect(getSkillAbsolutePath('user:../traversal.md')).toBeNull();
    });
  });

  describe('resolveToSkillPath', () => {
    it('should resolve direct skill files using actual paths', () => {
      // Use actual home directory path
      const homeDir = os.homedir();
      const filePath = path.join(homeDir, '.mycc-store', 'skills', 'my-skill.md');
      const result = resolveToSkillPath(filePath, 'user');
      expect(result).toBe('user:my-skill.md');
    });

    it('should resolve SKILL.md in subdirectory using actual paths', () => {
      // Use actual home directory path
      const homeDir = os.homedir();
      const filePath = path.join(homeDir, '.mycc-store', 'skills', 'my-skill', 'SKILL.md');
      const result = resolveToSkillPath(filePath, 'user');
      expect(result).toBe('user:my-skill/SKILL.md');
    });

    it('should reject nested paths', () => {
      const homeDir = os.homedir();
      const filePath = path.join(homeDir, '.mycc-store', 'skills', 'a', 'b', 'SKILL.md');
      expect(resolveToSkillPath(filePath, 'user')).toBeNull();
    });

    it('should reject path traversal attempts', () => {
      const homeDir = os.homedir();
      const filePath = path.join(homeDir, '.mycc-store', 'skills', '..', 'other.md');
      expect(resolveToSkillPath(filePath, 'user')).toBeNull();
    });

    it('should reject non-markdown files', () => {
      const homeDir = os.homedir();
      const filePath = path.join(homeDir, '.mycc-store', 'skills', 'my-skill.txt');
      expect(resolveToSkillPath(filePath, 'user')).toBeNull();
    });
  });
});