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
  createMockTeam,
  createMockWiki,
  createMockPeer,
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

// LineEditor fixtures (key / charKey / createMockStdout)
export { key, charKey, createMockStdout } from './line-editor.js';
