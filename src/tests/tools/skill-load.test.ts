// skill_load — merged from basics/content/errors

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { skillLoadTool } from '../../tools/skill_load.js';
import { createMockContext } from './test-utils.js';
import type { AgentContext, Skill, SkillModule } from '../../types.js';

vi.mock('../../context/shared/loader.js', () => ({
  loader: {
    getSkillLayer: vi.fn(() => 'project'),
    buildSkillIndexEntry: vi.fn(() => ({
      document: { domain: 'skills', title: '[project]:test', content: 'test', references: [] },
      contentHash: 'deadbeef',
    })),
    buildAllSkillEntries: vi.fn(() => []),
  },
}));

describe('skill-load-basics', () => {
  /**
   * skill-load-basics.test.ts - Basic tests for the skill_load tool
   * Tests metadata, happy path, and skill loading functionality
   */


  // Mock the loader singleton. buildSkillIndexEntry returns a minimal valid
  // SkillIndexEntry so skill_load's ctx.wiki.indexSkills([entry]) path runs.

  /**
   * Create a mock AgentContext with a mock SkillModule
   */
  function createMockContextWithSkills(workdir: string, skills: Skill[]): AgentContext {
    const skillModule: SkillModule = {
      loadSkills: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockReturnValue(skills),
      getSkill: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name)),
      listAllTools: vi.fn().mockReturnValue([]),
      compileCondition: vi.fn().mockResolvedValue({}),
      replaceCondition: vi.fn().mockResolvedValue({ success: true }),
      buildSkillIndexEntry: vi.fn(() => null),
      buildAllSkillEntries: vi.fn(() => []),
    };

    const ctx = createMockContext({ workdir });
    ctx.skill = skillModule;
    return ctx;
  }

  /**
   * Create a sample skill for testing
   */
  function createSampleSkill(overrides: Partial<Skill> = {}): Skill {
    return {
      name: 'test-skill',
      description: 'A test skill for unit testing',
      keywords: ['test', 'example'],
      content: '# Test Skill\n\nThis is the content of the test skill.\n\n## Usage\n\nUse this skill for testing purposes.',
      ...overrides,
    };
  }

  describe('skillLoadTool - Basics', () => {
    let ctx: AgentContext;

    beforeEach(() => {
      vi.clearAllMocks();
      ctx = createMockContextWithSkills('/tmp/test', []);
    });

    // =========================================================================
    // Metadata Tests
    // =========================================================================

    // =========================================================================
    // Loading Existing Skills - Happy Path
    // =========================================================================

    it('should return skill content when skill exists', async () => {
      const skill = createSampleSkill({ name: 'code-review' });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'code-review' });

      expect(result).toContain('# Skill: code-review');
      expect(result).toContain('Description: A test skill for unit testing');
      expect(result).toContain('Keywords: test, example');
      expect(result).toContain('---');
      expect(result).toContain('# Test Skill');
      expect(result).toContain('Use this skill for testing purposes.');
    });

    it('should call getSkill with correct skill name', async () => {
      const skill = createSampleSkill({ name: 'coordination' });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      await skillLoadTool.handler(ctx, { name: 'coordination' });

      expect(ctx.skill.getSkill).toHaveBeenCalledWith('coordination');
    });

    it('should call brief with loaded skill name', async () => {
      const skill = createSampleSkill();
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      await skillLoadTool.handler(ctx, { name: 'test-skill' });

      expect(ctx.core.brief).toHaveBeenCalledWith(
        'info',
        'skill_load',
        expect.stringContaining('Loaded: test-skill'),
      );
    });

    it('should handle skill with empty keywords', async () => {
      const skill = createSampleSkill({ name: 'minimal', keywords: [] });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'minimal' });

      expect(result).toContain('# Skill: minimal');
      expect(result).not.toContain('Keywords:');
    });

    it('should handle skill with multiple keywords', async () => {
      const skill = createSampleSkill({
        name: 'multi-keyword',
        keywords: ['code', 'review', 'quality', 'best-practices'],
      });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'multi-keyword' });

      expect(result).toContain('Keywords: code, review, quality, best-practices');
    });

    it('should handle skill with empty description', async () => {
      const skill = createSampleSkill({ name: 'no-desc', description: '' });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'no-desc' });

      expect(result).toContain('# Skill: no-desc');
      expect(result).not.toContain('Description: \n');
    });

    it('should handle skill with long content', async () => {
      const longContent = '# Comprehensive Guide\n\n' + 'Paragraph content.\n\n'.repeat(50);
      const skill = createSampleSkill({ name: 'long-skill', content: longContent });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'long-skill' });

      expect(result).toContain('# Skill: long-skill');
      expect(result).toContain('Comprehensive Guide');
      expect(result).toContain('Paragraph content.');
    });

    it('should handle skill with markdown formatting', async () => {
      const markdownContent = `# Code Review Skill

  ## Purpose
  Help review code effectively.

  ## Steps
  1. Read the code
  2. Identify issues
  3. Suggest improvements

  \`\`\`javascript
  console.log("example");
  \`\`\`

  **Bold text** and *italic text*.`;
      const skill = createSampleSkill({ name: 'formatted', content: markdownContent });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'formatted' });

      expect(result).toContain('## Purpose');
      expect(result).toContain('## Steps');
      expect(result).toContain('```javascript');
      expect(result).toContain('**Bold text**');
    });
  });
});

describe('skill-load-content', () => {
  /**
   * skill-load-content.test.ts - Content formatting tests for skill_load tool
   * Tests content handling, unicode, and special formatting cases
   */


  // Mock the loader singleton. buildSkillIndexEntry returns a minimal valid
  // SkillIndexEntry so skill_load's ctx.wiki.indexSkills([entry]) path runs.

  /**
   * Create a mock AgentContext with a mock SkillModule
   */
  function createMockContextWithSkills(workdir: string, skills: Skill[]): AgentContext {
    const skillModule: SkillModule = {
      loadSkills: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockReturnValue(skills),
      getSkill: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name)),
      listAllTools: vi.fn().mockReturnValue([]),
      compileCondition: vi.fn().mockResolvedValue({}),
      replaceCondition: vi.fn().mockResolvedValue({ success: true }),
      buildSkillIndexEntry: vi.fn(() => null),
      buildAllSkillEntries: vi.fn(() => []),
    };

    const ctx = createMockContext({ workdir });
    ctx.skill = skillModule;
    return ctx;
  }

  /**
   * Create a sample skill for testing
   */
  function createSampleSkill(overrides: Partial<Skill> = {}): Skill {
    return {
      name: 'test-skill',
      description: 'A test skill for unit testing',
      keywords: ['test', 'example'],
      content: '# Test Skill\n\nThis is the content of the test skill.',
      ...overrides,
    };
  }

  describe('skillLoadTool - Content', () => {
    let ctx: AgentContext;

    beforeEach(() => {
      vi.clearAllMocks();
      ctx = createMockContextWithSkills('/tmp/test', []);
    });

    // =========================================================================
    // Reading Skill Content
    // =========================================================================

    it('should return properly formatted skill content', async () => {
      const skill: Skill = {
        name: 'documentation',
        description: 'Write comprehensive documentation',
        keywords: ['docs', 'markdown', 'api'],
        content: '## Getting Started\n\nWrite clear documentation.\n\n## Tips\n- Be concise\n- Use examples',
      };
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'documentation' });

      expect(result).toMatch(/^# Skill: documentation/);
      expect(result).toContain('Description: Write comprehensive documentation');
      expect(result).toContain('Keywords: docs, markdown, api');
      expect(result).toContain('---');
      expect(result).toContain('## Getting Started');
      expect(result).toContain('## Tips');
    });

    it('should preserve original content formatting', async () => {
      const originalContent = `# Original Title

  Some paragraph.

  - List item 1
  - List item 2

  | Table | Header |
  |-------|--------|
  | Cell  | Value  |`;
      const skill = createSampleSkill({ name: 'preserved', content: originalContent });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'preserved' });

      const contentStart = result.indexOf('---\n\n') + 5;
      const extractedContent = result.slice(contentStart);
      expect(extractedContent).toBe(originalContent);
    });

    it('should auto-correct case-mismatched skill names', async () => {
      const skill = createSampleSkill({ name: 'Code-Review' });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const exactResult = await skillLoadTool.handler(ctx, { name: 'Code-Review' });
      expect(exactResult).toContain('# Skill: Code-Review');

      // Case-insensitive fallback: 'code-review' should match 'Code-Review'
      const caseMismatchResult = await skillLoadTool.handler(ctx, { name: 'code-review' });
      expect(caseMismatchResult).toContain('# Skill: Code-Review');
    });

    it('should handle skill with unicode content', async () => {
      const unicodeContent = `# Unicode 技能

  This skill supports unicode: 日本語, 中文, Español, Français.

  - Emoji: 🎉 🚀 ✅
  - Math: ∑ ∏ √`;
      const skill = createSampleSkill({ name: 'unicode', content: unicodeContent });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'unicode' });

      expect(result).toContain('# Skill: unicode');
      expect(result).toContain('日本語, 中文, Español, Français');
      expect(result).toContain('Emoji: 🎉 🚀 ✅');
      expect(result).toContain('Math: ∑ ∏ √');
    });

    it('should handle concurrent skill loads', async () => {
      const skills = [
        createSampleSkill({ name: 'skill-a' }),
        createSampleSkill({ name: 'skill-b' }),
        createSampleSkill({ name: 'skill-c' }),
      ];
      ctx = createMockContextWithSkills('/tmp/test', skills);

      const [resultA, resultB, resultC] = await Promise.all([
        skillLoadTool.handler(ctx, { name: 'skill-a' }),
        skillLoadTool.handler(ctx, { name: 'skill-b' }),
        skillLoadTool.handler(ctx, { name: 'skill-c' }),
      ]);

      expect(resultA).toContain('# Skill: skill-a');
      expect(resultB).toContain('# Skill: skill-b');
      expect(resultC).toContain('# Skill: skill-c');
    });

    it('should handle skill with empty content', async () => {
      const skill: Skill = {
        name: 'empty-content',
        description: 'Skill with no content',
        keywords: ['empty'],
        content: '',
      };
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'empty-content' });

      expect(result).toContain('# Skill: empty-content');
      expect(result).toContain('Description: Skill with no content');
      expect(result).toContain('Keywords: empty');
      expect(result).toContain('---');
    });

    it('should handle skill with only keywords (no description)', async () => {
      const skill: Skill = {
        name: 'keywords-only',
        description: '',
        keywords: ['keyword1', 'keyword2'],
        content: 'Some content',
      };
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'keywords-only' });

      expect(result).toContain('# Skill: keywords-only');
      expect(result).toContain('Keywords: keyword1, keyword2');
      expect(result).not.toContain('Description:');
    });

    it('should handle skill with only description (no keywords)', async () => {
      const skill: Skill = {
        name: 'description-only',
        description: 'Only has description',
        keywords: [],
        content: 'Content here',
      };
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'description-only' });

      expect(result).toContain('# Skill: description-only');
      expect(result).toContain('Description: Only has description');
      expect(result).not.toContain('Keywords:');
    });
  });
});

describe('skill-load-errors', () => {
  /**
   * skill-load-errors.test.ts - Error handling tests for the skill_load tool
   * Tests skill not found, invalid names, and edge cases
   */


  // Mock the loader singleton. buildSkillIndexEntry returns a minimal valid
  // SkillIndexEntry so skill_load's ctx.wiki.indexSkills([entry]) path runs.

  /**
   * Create a mock AgentContext with a mock SkillModule
   */
  function createMockContextWithSkills(workdir: string, skills: Skill[]): AgentContext {
    const skillModule: SkillModule = {
      loadSkills: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockReturnValue(skills),
      getSkill: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name)),
      listAllTools: vi.fn().mockReturnValue([]),
      compileCondition: vi.fn().mockResolvedValue({}),
      replaceCondition: vi.fn().mockResolvedValue({ success: true }),
      buildSkillIndexEntry: vi.fn(() => null),
      buildAllSkillEntries: vi.fn(() => []),
    };

    const ctx = createMockContext({ workdir });
    ctx.skill = skillModule;
    return ctx;
  }

  /**
   * Create a sample skill for testing
   */
  function createSampleSkill(overrides: Partial<Skill> = {}): Skill {
    return {
      name: 'test-skill',
      description: 'A test skill for unit testing',
      keywords: ['test', 'example'],
      content: '# Test Skill\n\nThis is the content of the test skill.',
      ...overrides,
    };
  }

  describe('skillLoadTool - Errors', () => {
    let ctx: AgentContext;

    beforeEach(() => {
      vi.clearAllMocks();
      ctx = createMockContextWithSkills('/tmp/test', []);
    });

    // =========================================================================
    // Skill Not Found Error
    // =========================================================================

    it('should return error when skill does not exist', async () => {
      const existingSkill = createSampleSkill({ name: 'existing' });
      ctx = createMockContextWithSkills('/tmp/test', [existingSkill]);

      const result = await skillLoadTool.handler(ctx, { name: 'nonexistent' });

      expect(result).toContain("Skill 'nonexistent' not found by exact name");
    });

    it('should return error when no skills are loaded', async () => {
      ctx = createMockContextWithSkills('/tmp/test', []);

      const result = await skillLoadTool.handler(ctx, { name: 'any-skill' });

      expect(result).toContain("Skill 'any-skill' not found by exact name");
    });

    it('should suggest using skill_search when skill not found', async () => {
      const skills = [
        createSampleSkill({ name: 'code-review', description: 'Review code' }),
        createSampleSkill({ name: 'testing', description: 'Write tests' }),
      ];
      ctx = createMockContextWithSkills('/tmp/test', skills);

      const result = await skillLoadTool.handler(ctx, { name: 'unknown' });

      expect(result).toContain("Skill 'unknown' not found by exact name");
      expect(result).toContain('skill_search');
    });

    // =========================================================================
    // Invalid Skill Names
    // =========================================================================

    it('should return error for empty skill name', async () => {
      const skill = createSampleSkill();
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: '' });

      expect(result).toContain('ERROR: The "name" parameter is required and must be a non-empty string.');
    });

    it('should handle skill name with special characters', async () => {
      const skill = createSampleSkill();
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'invalid@skill!' });

      expect(result).toContain("ERROR: Skill 'invalid@skill!' not found by exact name.");
    });

    it('should handle skill name with path traversal attempt', async () => {
      const skill = createSampleSkill();
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: '../../../etc/passwd' });

      expect(result).toContain("ERROR: Skill '../../../etc/passwd' not found by exact name.");
    });

    it('should handle skill name with only whitespace', async () => {
      const skill = createSampleSkill();
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: '   ' });

      expect(result).toContain('ERROR: The "name" parameter is required and must be a non-empty string.');
    });

    it('should handle numeric skill name', async () => {
      const skill = createSampleSkill({ name: '123' });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: '123' });

      expect(result).toContain('# Skill: 123');
    });

    // =========================================================================
    // Error Handling - Missing/Invalid Parameters
    // =========================================================================

    it('should return error when name parameter is missing', async () => {
      const skill = createSampleSkill();
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, {});

      expect(result).toContain('ERROR: The "name" parameter is required and must be a non-empty string.');
    });

    it('should handle invalid name type (number)', async () => {
      const skill = createSampleSkill();
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 123 as unknown as string });

      expect(result).toContain('ERROR: The "name" parameter is required and must be a non-empty string.');
    });

    it('should handle name with special characters that is valid', async () => {
      const skill = createSampleSkill({ name: 'my-skill_v2.0' });
      ctx = createMockContextWithSkills('/tmp/test', [skill]);

      const result = await skillLoadTool.handler(ctx, { name: 'my-skill_v2.0' });

      expect(result).toContain('# Skill: my-skill_v2.0');
    });
  });
});
