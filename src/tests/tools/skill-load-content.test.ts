/**
 * skill-load-content.test.ts - Content formatting tests for skill_load tool
 * Tests content handling, unicode, and special formatting cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { skillLoadTool } from '../../tools/skill_load.js';
import { createMockContext } from './test-utils.js';
import type { AgentContext, Skill, SkillModule } from '../../types.js';

/**
 * Create a mock AgentContext with a mock SkillModule
 */
function createMockContextWithSkills(workdir: string, skills: Skill[]): AgentContext {
  const skillModule: SkillModule = {
    loadSkills: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockReturnValue(skills),
    printSkills: vi.fn().mockReturnValue(skills.map(s => `- ${s.name}: ${s.description}`).join('\n')),
    getSkill: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name)),
  };

  const ctx = createMockContext(workdir);
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

  it('should return properly formatted skill content', () => {
    const skill: Skill = {
      name: 'documentation',
      description: 'Write comprehensive documentation',
      keywords: ['docs', 'markdown', 'api'],
      content: '## Getting Started\n\nWrite clear documentation.\n\n## Tips\n- Be concise\n- Use examples',
    };
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'documentation' });

    expect(result).toMatch(/^# Skill: documentation/);
    expect(result).toContain('Description: Write comprehensive documentation');
    expect(result).toContain('Keywords: docs, markdown, api');
    expect(result).toContain('---');
    expect(result).toContain('## Getting Started');
    expect(result).toContain('## Tips');
  });

  it('should preserve original content formatting', () => {
    const originalContent = `# Original Title

Some paragraph.

- List item 1
- List item 2

| Table | Header |
|-------|--------|
| Cell  | Value  |`;
    const skill = createSampleSkill({ name: 'preserved', content: originalContent });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'preserved' });

    const contentStart = result.indexOf('---\n\n') + 5;
    const extractedContent = result.slice(contentStart);
    expect(extractedContent).toBe(originalContent);
  });

  it('should handle case-sensitive skill names', () => {
    const skill = createSampleSkill({ name: 'Code-Review' });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const exactResult = skillLoadTool.handler(ctx, { name: 'Code-Review' });
    expect(exactResult).toContain('# Skill: Code-Review');

    const caseResult = skillLoadTool.handler(ctx, { name: 'code-review' });
    expect(caseResult).toContain("Skill 'code-review' not found");
  });

  it('should handle skill with unicode content', () => {
    const unicodeContent = `# Unicode 技能

This skill supports unicode: 日本語, 中文, Español, Français.

- Emoji: 🎉 🚀 ✅
- Math: ∑ ∏ √`;
    const skill = createSampleSkill({ name: 'unicode', content: unicodeContent });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'unicode' });

    expect(result).toContain('# Skill: unicode');
    expect(result).toContain('日本語, 中文, Español, Français');
    expect(result).toContain('Emoji: 🎉 🚀 ✅');
    expect(result).toContain('Math: ∑ ∏ √');
  });

  it('should handle concurrent skill loads', () => {
    const skills = [
      createSampleSkill({ name: 'skill-a' }),
      createSampleSkill({ name: 'skill-b' }),
      createSampleSkill({ name: 'skill-c' }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const resultA = skillLoadTool.handler(ctx, { name: 'skill-a' });
    const resultB = skillLoadTool.handler(ctx, { name: 'skill-b' });
    const resultC = skillLoadTool.handler(ctx, { name: 'skill-c' });

    expect(resultA).toContain('# Skill: skill-a');
    expect(resultB).toContain('# Skill: skill-b');
    expect(resultC).toContain('# Skill: skill-c');
  });

  it('should handle skill with empty content', () => {
    const skill: Skill = {
      name: 'empty-content',
      description: 'Skill with no content',
      keywords: ['empty'],
      content: '',
    };
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'empty-content' });

    expect(result).toContain('# Skill: empty-content');
    expect(result).toContain('Description: Skill with no content');
    expect(result).toContain('Keywords: empty');
    expect(result).toContain('---');
  });

  it('should handle skill with only keywords (no description)', () => {
    const skill: Skill = {
      name: 'keywords-only',
      description: '',
      keywords: ['keyword1', 'keyword2'],
      content: 'Some content',
    };
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'keywords-only' });

    expect(result).toContain('# Skill: keywords-only');
    expect(result).toContain('Keywords: keyword1, keyword2');
    expect(result).not.toContain('Description:');
  });

  it('should handle skill with only description (no keywords)', () => {
    const skill: Skill = {
      name: 'description-only',
      description: 'Only has description',
      keywords: [],
      content: 'Content here',
    };
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'description-only' });

    expect(result).toContain('# Skill: description-only');
    expect(result).toContain('Description: Only has description');
    expect(result).not.toContain('Keywords:');
  });
});