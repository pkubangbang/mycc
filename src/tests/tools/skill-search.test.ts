/**
 * skill-search.test.ts - Tests for the skill_search tool
 * Tests metadata, search functionality, and edge cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { skillSearchTool } from '../../tools/skill_search.js';
import { createMockContext } from './test-utils.js';
import type { AgentContext, Skill, SkillModule, WikiModule } from '../../types.js';

// Mock the loader singleton
vi.mock('../../context/shared/loader.js', () => ({
  loader: {
    getSkillLayer: vi.fn(() => 'project'),
    indexSkillToWiki: vi.fn(() => Promise.resolve()),
    indexAllSkillsToWiki: vi.fn(() => Promise.resolve()),
  },
}));

// Mock config
vi.mock('../../config.js', () => ({
  getSkillMatchThreshold: vi.fn(() => 0.5),
}));

/**
 * Create a mock AgentContext with mock SkillModule and WikiModule
 */
function createMockContextWithSkills(
  workdir: string,
  skills: Skill[],
  wikiGetResult: Array<{ document: { title: string; content: string }; similarity: number }> = [],
): AgentContext {
  const skillModule: SkillModule = {
    loadSkills: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockReturnValue(skills),
    getSkill: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name)),
  };

  // Mock wiki with configurable return values
  const wikiModule: WikiModule = {
    get: vi.fn().mockResolvedValue(wikiGetResult),
    registerDomain: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn().mockResolvedValue({ accepted: true, hash: 'mock-hash' }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };

  const ctx = createMockContext(workdir);
  ctx.skill = skillModule;
  ctx.wiki = wikiModule;
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

describe('skillSearchTool - Basics', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContextWithSkills('/tmp/test', []);
  });

  // =========================================================================
  // Metadata Tests
  // =========================================================================

  it('should have correct tool metadata', () => {
    expect(skillSearchTool.name).toBe('skill_search');
    expect(skillSearchTool.description).toContain('Search skills by keywords');
    expect(skillSearchTool.scope).toEqual(['main', 'child']);
    expect(skillSearchTool.input_schema.required).toContain('search');
    expect(skillSearchTool.input_schema.properties).toHaveProperty('search');
  });

  // =========================================================================
  // Search with Name/Keyword Matching
  // =========================================================================

  it('should find skills by name substring match', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code quality' }),
      createSampleSkill({ name: 'testing', description: 'Write and run tests' }),
      createSampleSkill({ name: 'deployment', description: 'Deploy applications' }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const result = await skillSearchTool.handler(ctx, { search: 'code' });

    expect(result).toContain('code-review');
    expect(result).toContain('name/keyword match');
    expect(result).not.toContain('testing');
  });

  it('should find skills by keyword match', async () => {
    const skills = [
      createSampleSkill({ name: 'review', description: 'Code review skill', keywords: ['code', 'quality'] }),
      createSampleSkill({ name: 'deploy', description: 'Deployment skill', keywords: ['ci', 'cd'] }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const result = await skillSearchTool.handler(ctx, { search: 'code quality' });

    expect(result).toContain('review');
    expect(result).toContain('name/keyword match');
    expect(result).not.toContain('deploy');
  });

  it('should deduplicate results across wiki and name/keyword search', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code'] }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      { document: { title: 'code-review', content: 'Scope: project\nName: code-review\nDescription: Review code Keywords: code' }, similarity: 0.85 },
    ]);

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    // Should mention code-review only once
    const matches = (result.match(/code-review/g) || []).length;
    // Header mentions it, and the skill line mentions it - but only one result entry
    expect(result).toContain('Found 1 skill');
  });

  it('should list correct count of found skills', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code' }),
      createSampleSkill({ name: 'testing', description: 'Write tests' }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain('Found 1 skill');
  });

  it('should handle wiki search failures gracefully', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code' }),
    ];
    // Wiki.get throws error
    const skillModule: SkillModule = {
      loadSkills: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockReturnValue(skills),
      getSkill: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name)),
    };
    const wikiModule: WikiModule = {
      get: vi.fn().mockRejectedValue(new Error('Embedding model not available')),
      registerDomain: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockResolvedValue({ accepted: true, hash: 'mock-hash' }),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const ctx2 = createMockContext('/tmp/test');
    ctx2.skill = skillModule;
    ctx2.wiki = wikiModule;

    const result = await skillSearchTool.handler(ctx2, { search: 'code review' });

    // Should still find by name/keyword match even if wiki fails
    expect(result).toContain('code-review');
    expect(result).toContain('Found 1 skill');
  });

  // =========================================================================
  // No Results
  // =========================================================================

  it('should return helpful message when no skills match', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code' }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const result = await skillSearchTool.handler(ctx, { search: 'cooking recipes' });

    expect(result).toContain("No skills found matching 'cooking recipes'");
    expect(result).toContain('Try different keywords');
  });

  it('should handle empty search parameter', async () => {
    const skills = [createSampleSkill()];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const result = await skillSearchTool.handler(ctx, { search: '' });

    expect(result).toContain('ERROR');
    expect(result).toContain('search');
  });

  it('should handle search with only whitespace', async () => {
    const skills = [createSampleSkill()];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const result = await skillSearchTool.handler(ctx, { search: '   ' });

    expect(result).toContain('ERROR');
  });

  it('should handle search with no matching keywords', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', keywords: ['code', 'review', 'quality'] }),
      createSampleSkill({ name: 'testing', keywords: ['test', 'unit', 'integration'] }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const result = await skillSearchTool.handler(ctx, { search: 'deployment ci' });

    expect(result).toContain("No skills found matching 'deployment ci'");
  });

  // =========================================================================
  // Combined Results (Wiki + Name/Keyword)
  // =========================================================================

  it('should show semantic match percentage from wiki results', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code', keywords: ['code'] }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills, [
      { document: { title: 'code-review', content: 'Scope: project\nName: code-review\nDescription: Review code Keywords: code' }, similarity: 0.75 },
    ]);

    const result = await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(result).toContain('75%');
  });

  it('should include skill keywords in name/keyword match results', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code quality', keywords: ['code', 'quality', 'best-practices'] }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    const result = await skillSearchTool.handler(ctx, { search: 'quality' });

    expect(result).toContain('code-review');
    expect(result).toContain('Keywords: code, quality, best-practices');
  });

  it('should call brief with match summary', async () => {
    const skills = [
      createSampleSkill({ name: 'code-review', description: 'Review code' }),
    ];
    ctx = createMockContextWithSkills('/tmp/test', skills);

    await skillSearchTool.handler(ctx, { search: 'code review' });

    expect(ctx.core.brief).toHaveBeenCalledWith('info', 'skill_search', expect.stringContaining('code-review'), 'code review');
  });
});
