/**
 * Test utilities index
 * Re-exports common testing utilities for convenience
 */

// Mock factories
export {
  createMockContext,
  createMinimalMockContext,
  createMockCore,
  createMockTodo,
  createMockMail,
  createMockSkill,
  createMockIssue,
  createMockBg,
  createMockWt,
  createMockTeam,
  createMockWiki,
  type MockContextOptions,
} from './mock-context.js';

// Fixtures
export {
  sampleFiles,
  samplePaths,
  contextFactories,
  bashOutputs,
  sampleTodoItems,
  sampleIssues,
  sampleMails,
} from './fixtures.js';