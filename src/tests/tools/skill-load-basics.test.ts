/**
 * skill-load-basics.test.ts - Basic tests for the skill_load tool
 * Tests metadata, happy path, and skill loading functionality
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

  it('should have correct tool metadata', () => {
    expect(skillLoadTool.name).toBe('skill_load');
    expect(skillLoadTool.description).toContain('Load a skill by name');
    expect(skillLoadTool.scope).toEqual(['main', 'child']);
    expect(skillLoadTool.input_schema.required).toContain('name');
    expect(skillLoadTool.input_schema.properties).toHaveProperty('name');
  });

  // =========================================================================
  // Loading Existing Skills - Happy Path
  // =========================================================================

  it('should return skill content when skill exists', () => {
    const skill = createSampleSkill({ name: 'code-review' });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'code-review' });

    expect(result).toContain('# Skill: code-review');
    expect(result).toContain('Description: A test skill for unit testing');
    expect(result).toContain('Keywords: test, example');
    expect(result).toContain('---');
    expect(result).toContain('# Test Skill');
    expect(result).toContain('Use this skill for testing purposes.');
  });

  it('should call getSkill with correct skill name', () => {
    const skill = createSampleSkill({ name: 'coordination' });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    skillLoadTool.handler(ctx, { name: 'coordination' });

    expect(ctx.skill.getSkill).toHaveBeenCalledWith('coordination');
  });

  it('should call brief with skill name', () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    skillLoadTool.handler(ctx, { name: 'test-skill' });

    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'skill_load', 'test-skill');
  });

  it('should handle skill with empty keywords', () => {
    const skill = createSampleSkill({ name: 'minimal', keywords: [] });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'minimal' });

    expect(result).toContain('# Skill: minimal');
    expect(result).not.toContain('Keywords:');
  });

  it('should handle skill with multiple keywords', () => {
    const skill = createSampleSkill({
      name: 'multi-keyword',
      keywords: ['code', 'review', 'quality', 'best-practices'],
    });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'multi-keyword' });

    expect(result).toContain('Keywords: code, review, quality, best-practices');
  });

  it('should handle skill with empty description', () => {
    const skill = createSampleSkill({ name: 'no-desc', description: '' });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'no-desc' });

    expect(result).toContain('# Skill: no-desc');
    expect(result).not.toContain('Description: \n');
  });

  it('should handle skill with long content', () => {
    const longContent = '# Comprehensive Guide\n\n' + 'Paragraph content.\n\n'.repeat(50);
    const skill = createSampleSkill({ name: 'long-skill', content: longContent });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'long-skill' });

    expect(result).toContain('# Skill: long-skill');
    expect(result).toContain('Comprehensive Guide');
    expect(result).toContain('Paragraph content.');
  });

  it('should handle skill with markdown formatting', () => {
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

    const result = skillLoadTool.handler(ctx, { name: 'formatted' });

    expect(result).toContain('## Purpose');
    expect(result).toContain('## Steps');
    expect(result).toContain('```javascript');
    expect(result).toContain('**Bold text**');
  });
});