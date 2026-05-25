/**
 * skill-load-errors.test.ts - Error handling tests for the skill_load tool
 * Tests skill not found, invalid names, and edge cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { skillLoadTool } from '../../tools/skill_load.js';
import { createMockContext } from './test-utils.js';
import type { AgentContext, Skill, SkillModule } from '../../types.js';

// Mock the loader singleton
vi.mock('../../context/shared/loader.js', () => ({
  loader: {
    getSkillLayer: vi.fn(() => 'project'),
    indexSkillToWiki: vi.fn(() => Promise.resolve()),
    indexAllSkillsToWiki: vi.fn(() => Promise.resolve()),
  },
}));

/**
 * Create a mock AgentContext with a mock SkillModule
 */
function createMockContextWithSkills(workdir: string, skills: Skill[]): AgentContext {
  const skillModule: SkillModule = {
    loadSkills: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockReturnValue(skills),
    getSkill: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name)),
    listAllTools: vi.fn().mockReturnValue([]),
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

    expect(result).toContain('ERROR');
    expect(result).toContain('name');
  });

  it('should handle skill name with special characters', async () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = await skillLoadTool.handler(ctx, { name: 'invalid@skill!' });

    expect(result).toContain("Skill 'invalid@skill!' not found by exact name");
  });

  it('should handle skill name with path traversal attempt', async () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = await skillLoadTool.handler(ctx, { name: '../../../etc/passwd' });

    expect(result).toContain("Skill '../../../etc/passwd' not found by exact name");
  });

  it('should handle skill name with only whitespace', async () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = await skillLoadTool.handler(ctx, { name: '   ' });

    expect(result).toContain('ERROR');
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

    expect(result).toContain('ERROR');
    expect(result).toContain('name');
  });

  it('should handle invalid name type (number)', async () => {
    const skill = createSampleSkill();
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = await skillLoadTool.handler(ctx, { name: 123 as unknown as string });

    expect(result).toContain('ERROR');
  });

  it('should handle name with special characters that is valid', async () => {
    const skill = createSampleSkill({ name: 'my-skill_v2.0' });
    ctx = createMockContextWithSkills('/tmp/test', [skill]);

    const result = await skillLoadTool.handler(ctx, { name: 'my-skill_v2.0' });

    expect(result).toContain('# Skill: my-skill_v2.0');
  });
});
