/**
 * fixtures.ts - Common test fixtures and sample data
 */

import type { AgentContext } from '../../types.js';

/**
 * Sample file contents for testing
 */
export const sampleFiles = {
  simpleText: 'Hello, World!',
  multilineText: `Line 1
Line 2
Line 3`,
  jsonContent: JSON.stringify({ key: 'value', nested: { a: 1 } }, null, 2),
  codeContent: `function hello(name: string) {
  console.log(\`Hello, \${name}!\`);
}
`,
};

/**
 * Sample paths for testing (these should not actually exist)
 */
export const samplePaths = {
  validFile: '/workspace/test.txt',
  validDir: '/workspace/src',
  deepFile: '/workspace/src/utils/helper.ts',
  invalidPath: '/nonexistent/path/file.txt',
};

/**
 * Mock context factory for common scenarios
 */
export const contextFactories = {
  /**
   * Context for file operations (requires workdir)
   */
  fileOps: (workdir: string): AgentContext => ({
    core: {
      getWorkDir: () => workdir,
      setWorkDir: () => {},
      getName: () => 'test-agent',
      brief: () => {},
      verbose: () => {},
      question: async () => '',
      webSearch: async () => [],
      webFetch: async () => ({ title: '', content: '', links: [] }),
      imgDescribe: async () => '',
    },
    todo: {} as never,
    mail: {} as never,
    skill: {} as never,
    issue: {} as never,
    bg: {} as never,
    wt: {} as never,
    team: {} as never,
    wiki: {} as never,
  }),
};

/**
 * Test command outputs for mocking bash results
 */
export const bashOutputs = {
  success: {
    stdout: 'output',
    stderr: '',
    exitCode: 0,
    interrupted: false,
    timedOut: false,
  },
  failure: {
    stdout: '',
    stderr: 'command not found',
    exitCode: 127,
    interrupted: false,
    timedOut: false,
  },
  timeout: {
    stdout: '',
    stderr: '',
    exitCode: 137,
    interrupted: false,
    timedOut: true,
  },
  interrupted: {
    stdout: '',
    stderr: '',
    exitCode: -1,
    interrupted: true,
    timedOut: false,
  },
};

/**
 * Sample todo items for testing
 */
export const sampleTodoItems = [
  { id: 0, name: 'First task', done: false, note: 'Note 1' },
  { id: 1, name: 'Second task', done: true, note: undefined },
  { id: 2, name: 'Third task', done: false, note: 'Note 3' },
];

/**
 * Sample issue data for testing
 */
export const sampleIssues = {
  pending: {
    title: 'Test Issue',
    content: 'Issue description',
    blockedBy: [],
  },
  blocked: {
    title: 'Blocked Issue',
    content: 'This is blocked',
    blockedBy: [1],
  },
  complex: {
    title: 'Complex Issue',
    content: 'Multiple blockers',
    blockedBy: [1, 2, 3],
  },
};

/**
 * Sample mail data for testing
 */
export const sampleMails = [
  {
    id: 'mail-1',
    from: 'sender-1',
    title: 'Test Mail 1',
    content: 'Mail content 1',
    timestamp: new Date('2024-01-15T10:00:00Z'),
  },
  {
    id: 'mail-2',
    from: 'sender-2',
    title: 'Test Mail 2',
    content: 'Mail content 2',
    timestamp: new Date('2024-01-15T11:00:00Z'),
  },
];