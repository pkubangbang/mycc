/**
 * skill-load-errors.test.ts - Error handling tests for the skill_load tool
 * Tests skill not found, invalid names, and edge cases
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

describe('skillLoadTool - Errors', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContextWithSkills('/tmp/test', []);
  });

  // =========================================================================
  // Skill Not Found Error
  // =========================================================================

  it('should return error when skill does not exist', () => {
    const existingSkill = createSampleSkill({ name: 'existing' });
    ctx = createMockContextWithSkills('/tmp/test', [existingSkill]);

    const result = skillLoadTool.handler(ctx, { name: 'nonexistent' });

    expect(result).toContain("Skill 'nonexistent' not found");
    expect(result).toContain('Available skills:');
    expect(result).toContain('- existing: A test skill for unit testing');
  });

  it('should return message when no skills are loaded', () => {
    ctx = createMockContextWithSkills('/tmp/test', []);

    const result = skillLoadTool.handler(ctx, { name: 'any-skill' });

    expect(result).toContain("Skill 'any-skill' not found");
    expect(result).toContain('No skills are currently loaded');
  });

  it('should list all available skills when skill not found', () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code' }),
      createSampleSkill({ name: 'testing', description: 'Write tests' }),
      createSampleSkill({ name: 'coordination', description: 'Coordinate tasks' }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const result = skillLoadTool.handler(ctx, { name: 'unknown' });

    expect(result).toContain('- code-review: Review code');
    expect(result).toContain('- testing: Write tests');
    expect(result).toContain('- coordination: Coordinate tasks');
  });

  // =========================================================================
  // Invalid Skill Names
  // =========================================================================

  it('should handle empty skill name', () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: '' });

    expect(result).toContain("Skill '' not found");
  });

  it('should handle skill name with special characters', () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'invalid@skill!' });

    expect(result).toContain("Skill 'invalid@skill!' not found");
  });

  it('should handle skill name with path traversal attempt', () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: '../../../etc/passwd' });

    expect(result).toContain("Skill '../../../etc/passwd' not found");
  });

  it('should handle skill name with only whitespace', () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: '   ' });

    expect(result).toContain("Skill '   ' not found");
  });

  it('should handle numeric skill name', () => {
    const skill = createSampleSkill({ name: '123' });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: '123' });

    expect(result).toContain('# Skill: 123');
  });

  // =========================================================================
  // Error Handling - Missing/Invalid Parameters
  // =========================================================================

  it('should handle missing name parameter', () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, {});

    expect(result).toContain("Skill 'undefined' not found");
  });

  it('should handle invalid name type (number)', () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 123 });

    expect(result).toContain("Skill '123' not found");
  });

  it('should handle name with special characters that is valid', () => {
    const skill = createSampleSkill({ name: 'my-skill_v2.0' });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = skillLoadTool.handler(ctx, { name: 'my-skill_v2.0' });

    expect(result).toContain('# Skill: my-skill_v2.0');
  });
});