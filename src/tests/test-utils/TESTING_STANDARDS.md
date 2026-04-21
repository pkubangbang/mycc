# Testing Standards and Patterns

This document defines the standard testing patterns for the mycc project. All test files should follow these conventions.

## Vitest Configuration

- **Globals enabled**: Use `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` without imports
- **Environment**: Node.js
- **Test timeout**: 10 seconds (configured in vitest.config.ts)

## Test File Organization

```
src/tests/
├── test-utils/          # Shared testing utilities
│   ├── mock-context.ts  # AgentContext mock factories
│   ├── fixtures.ts      # Test fixtures and data
│   └── helpers.ts       # Common test helpers
├── tools/               # Tool tests
│   ├── test-utils.ts    # Tool-specific utilities
│   ├── bash.test.ts
│   └── ...
├── agent-io/            # Agent IO tests
├── memory-store/        # Memory store tests
└── line-editor/         # Line editor tests
```

## Required Imports

```typescript
// Always import vitest globals explicitly (for clarity)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import types with 'type' prefix
import type { AgentContext, SomeType } from '../../types.js';

// Import modules under test after mocks are set up
```

## Mocking Patterns

### 1. Mocking agentIO (for tools that use it)

```typescript
// Mock agentIO BEFORE importing the module under test
vi.mock('../../loop/agent-io.js', () => ({
  agentIO: {
    exec: vi.fn(),
    // other methods as needed
  },
}));

// Then import
import { agentIO } from '../../loop/agent-io.js';
import { someTool } from '../../tools/some-tool.js';
```

### 2. Creating Mock AgentContext

```typescript
// Use createMockContext from test-utils/mock-context.ts
import { createMockContext } from '../test-utils/mock-context.js';

describe('my tool', () => {
  let ctx: AgentContext;
  
  beforeEach(() => {
    ctx = createMockContext({ workdir: '/tmp/test' });
  });
});
```

### 3. Mocking Ollama/LLM calls

```typescript
vi.mock('../../ollama.js', () => ({
  retryChat: vi.fn().mockResolvedValue({
    message: { content: 'Mocked response' },
  }),
  MODEL: 'test-model',
}));
```

### 4. Mocking external modules

```typescript
vi.mock('some-external-module', () => ({
  someFunction: vi.fn(() => 'mocked value'),
}));
```

## Test Structure Pattern

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockContext } from '../test-utils/mock-context.js';
import type { AgentContext } from '../../types.js';

// Mock external dependencies BEFORE imports
vi.mock('../../external-dep.js', () => ({
  externalDep: vi.fn(),
}));

// Import after mocks
import { myTool } from '../../tools/my-tool.js';

describe('myTool', () => {
  let ctx: AgentContext;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handler', () => {
    it('should handle happy path', async () => {
      const result = await myTool.handler(ctx, { param: 'value' });
      expect(result).toContain('expected');
    });

    it('should handle errors', async () => {
      // Test error handling
    });

    it('should handle edge cases', async () => {
      // Test boundary conditions
    });
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(myTool.name).toBe('expected-name');
    });

    it('should have correct scope', () => {
      expect(myTool.scope).toEqual(['main', 'child']);
    });
  });
});
```

## Test Isolation Rules

1. **Reset state in beforeEach**: Clear any shared state
2. **Use local variables**: Avoid module-level mutable state
3. **Clear mocks**: Call `vi.clearAllMocks()` in beforeEach
4. **Restore mocks**: Call `vi.restoreAllMocks()` in afterEach
5. **Create fresh context**: Create a new `ctx` in each beforeEach

## File System Tests

For tests that interact with the file system:

```typescript
import { createTempDir, removeTempDir } from './test-utils.js';

describe('file operations', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('should read file', async () => {
    // Use tempDir for file operations
  });
});
```

## What to Test

### Happy Path Tests
- Normal operation with valid inputs
- Expected return values
- Side effects (mocks called correctly)

### Edge Cases
- Empty input
- Null/undefined handling
- Boundary values
- Unicode/encoding issues

### Error Handling
- Invalid input
- External dependency failures
- Timeout scenarios
- Permission errors

### Security Tests (when applicable)
- Path traversal attacks
- Command injection
- Input validation

## Assertions

### Common Assertions

```typescript
// Equality
expect(value).toBe(expected);
expect(value).toEqual({ key: 'value' });

// Containment
expect(string).toContain('substring');
expect(array).toContain(item);

// Mocks
expect(mockFn).toHaveBeenCalled();
expect(mockFn).toHaveBeenCalledWith(arg1, arg2);
expect(mockFn).toHaveBeenCalledTimes(2);

// Errors
expect(() => fn()).toThrow();
await expect(promise).rejects.toThrow();

// Truthiness
expect(value).toBeTruthy();
expect(value).toBeFalsy();
expect(value).toBeNull();
expect(value).toBeUndefined();
```

## Test File Size Limit

Keep test files under **300 lines**. Split by functionality:

```typescript
// Instead of one large file:
// mytool.test.ts (500 lines)

// Split into:
// mytool-basics.test.ts (150 lines)
// mytool-errors.test.ts (150 lines)
// mytool-edge-cases.test.ts (100 lines)
```

## Naming Conventions

- Test files: `*.test.ts`
- Spec files: `*.spec.ts` (alternative, prefer .test.ts)
- Describe blocks: Module or function name
- Test names: Should statements ("should do X when Y")

## Async Testing

```typescript
// Always use async/await
it('should handle async operation', async () => {
  const result = await asyncFunction();
  expect(result).toBe('expected');
});

// For promises that should reject
it('should reject on error', async () => {
  await expect(failingPromise()).rejects.toThrow();
});
```

## Time-based Tests

```typescript
// Use vi.useFakeTimers for time-dependent tests
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('should timeout after 5 seconds', async () => {
  const promise = someOperation();
  vi.advanceTimersByTime(5000);
  await expect(promise).rejects.toThrow('timeout');
});
```

## Checklist for New Test Files

- [ ] Imports at top with vitest globals explicitly imported
- [ ] Mocks defined before module imports
- [ ] describe block with module name
- [ ] beforeEach for setup
- [ ] afterEach for cleanup
- [ ] Multiple describe blocks for different functionalities
- [ ] Happy path tests
- [ ] Error handling tests
- [ ] Edge case tests
- [ ] Metadata tests (name, scope, schema)
- [ ] File under 300 lines