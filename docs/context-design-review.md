# Agent-Context Design Review: Team Discussion Summary

**Date**: 2026-05-06
**Participants**: dev-aggressive, architect-conservative, harness-specialist
**Scope**: Review of BaseCore → Core/ChildCore inheritance and AgentContext architecture

---

## Executive Summary

The team reviewed the agent-context architecture with three different lenses:
- **Aggressive Developer**: Focus on code quality, DRY, modern patterns
- **Conservative Architect**: Focus on stability, maintainability, migration costs
- **Harness Specialist**: Focus on testing, IPC, tool integration

### Key Consensus Points ✅
1. **BaseCore inheritance is appropriate** - shallow 2-level hierarchy, genuine "is-a" relationship
2. **IPC wrapper pattern is standard** - type-safe, debuggable, proven approach
3. **Parent/ChildContext separation is correct** - different ownership semantics
4. **Composition in contexts is clean** - modules implement interfaces, good for testing

### Critical Issues Found 🚨
1. **Date serialization bug** - IPC converts Date → string, breaks child processes
2. **~120 lines duplicated** - formatting logic in IssueManager and ChildIssue
3. **No IPC testing** - 4 child modules untested, integration paths never exercised
4. **Implicit behavior** - Loader silent mode is hidden, Core.getMode() not in interface

---

## Team Findings

### 1. Inheritance Hierarchy: BaseCore → Core/ChildCore

**Architect's View** (Conservative):
> ✅ **Appropriate design**. BaseCore holds truly shared state (workDir, mindmap, webSearch/webFetch). Subclasses genuinely have different implementations. This is NOT gratuitous inheritance.

**Dev's View** (Aggressive):
> ⚠️ **Questionable but acceptable**. BaseCore only holds 3 properties - thin for inheritance. Core has `getMode()`/`setMode()` that ChildCore stubs with hardcoded `'normal'` - violates Liskov. However, migration cost is higher than benefit.

**Harness View** (Specialist):
> ⚠️ **Testing impact**. `Core.getMode()` is implementation-only (not in `CoreModule` interface). Makes mocking inconsistent. `requestGrant()` behaves completely differently (local vs IPC), so unit tests don't match integration.

**Decision**: Keep inheritance, but add `getMode()` to interface for consistency.

---

### 2. Module Abstractions

**Well-Designed** (All agree):
- `Todo` - pure in-memory, no IPC, easy to test
- `MailBox` - file-based but isolated, good testability
- `BackgroundTasks` - dependency injection pattern, clean

**Problematic**:
- `IssueModule` - duplicate formatting logic (~120 lines)
- `WikiModule` - 733 lines, too complex to unit test
- `Skill/Loader` - silent mode is implicit behavioral difference

**Architect's Concern**:
> The "silent mode" in Loader is a hidden behavioral difference. Same interface, different console output. Risk of unexpected behavior.

**Dev's Suggestion**:
> WikiManager should be split: `EmbeddingService` + `WALService` + `WikiManager` (orchestrator). This enables unit testing of each service.

---

### 3. Duplication Analysis

#### Critical Duplication (Fix Now)

**Issue formatting** - ~120 lines duplicated:
```
src/context/parent/issue.ts:112-160   (printIssues + printIssue)
src/context/child/issue.ts:47-109     (IDENTICAL code)
```

**All three specialists flagged this**. Tests don't catch it because they mock the interface.

**Solution**: Create `src/context/shared/format-issue.ts`:
```typescript
export function formatIssueList(issues: Issue[]): string { ... }
export function formatIssueDetail(issue: Issue): string { ... }
```

#### IPC Boilerplate (Consider for Future)

- ParentContext: 200+ lines of handler registration
- Child modules: Each method is `ipc.sendRequest()` wrapper

**Dev's Suggestion**: Proxy pattern could eliminate 300+ lines:
```typescript
function createIpcProxy<T>(prefix: string): T {
  return new Proxy({} as T, {
    get: (_, prop) => async (...args) => 
      ipc.sendRequest(`${prefix}_${prop}`, args)
  });
}
```

**Architect's Pushback**:
> Proxy magic loses type safety and debuggability. Current explicit approach is more maintainable. Consider only for new modules, not refactoring existing ones.

---

### 4. IPC Boundary Issues

#### Critical Bug: Date Serialization 🚨

**Problem**: `Issue.createdAt` is `Date`, but IPC serialization converts to string:
```typescript
// Parent sends:
return { createdAt: new Date() };

// IPC serialization:
JSON.stringify({ createdAt: new Date() })
// → "{ createdAt: "2024-01-15T10:30:00.000Z" }" // string!

// Child receives:
result.createdAt // This is now a STRING, not Date!
result.createdAt.getTime() // RUNTIME ERROR
```

**Harness's Finding**:
> Affects 3 Date fields: `Issue.createdAt`, `IssueComment.timestamp`, `WALEntry.timestamp`. No round-trip tests exist.

**Solution**: Add deserialization helpers in `ipc-helpers.ts`:
```typescript
function deserializeIssue(data: unknown): Issue {
  const issue = data as Issue;
  return {
    ...issue,
    createdAt: new Date(issue.createdAt),
    comments: issue.comments.map(c => ({
      ...c,
      timestamp: new Date(c.timestamp)
    }))
  };
}
```

#### IPC Handler Count

- 26 handlers registered in `ParentContext.initializeIpcHandlers()`
- Each child module call → IPC round-trip
- No caching layer for read-heavy data

**Performance Consideration**:
> Child processes make IPC calls for every Issue/Wiki operation. Consider adding read-through caching for frequently accessed data (issue lists, domain metadata).

---

### 5. Testing Ergonomics

#### What IS Tested ✅
- `Core` (parent) - mode system, requestGrant
- `ChildCore` - requestGrant IPC (with mocked ipc-helpers)
- Individual tools - with `createMockContext()`
- `MemoryStore` - comprehensive integration tests

#### What is NOT Tested ❌
- `ChildIssue`, `ChildWiki`, `ChildWt`, `ChildTeam` - **zero tests**
- `ParentContext.initializeIpcHandlers()` - never tested
- Date serialization - no round-trip tests
- IPC boundary integration

**Harness's Assessment**:
> `createMockContext()` creates 238 lines of mock factories - symptom of architectural complexity. Mocks only support unit testing, not integration.

**Recommended Addition**:
```typescript
// src/tests/test-utils/ipc-harness.ts
export function createIpcHarness(): {
  parent: { registerHandler, handleRequest };
  child: { sendRequest };
}
```

This would enable integration tests for parent↔child communication.

---

### 6. Mock Context Issues

**Current Pattern**:
```typescript
export function createMockContext(options: MockContextOptions = {}): AgentContext {
  return {
    core: createMockCore({ ...options.core }),
    todo: createMockTodo(options.todo),
    // ... 7 more modules
  };
}
```

**Problems**:
1. Partial overrides lose type safety:
   ```typescript
   createMockContext({
     core: { getMode: () => 'plan' } // Missing other CoreModule methods!
   });
   ```
2. No state sharing between tests (MemoryStore is global)
3. No IPC simulation

**Suggested Improvement**:
```typescript
// Deep partial with defaults
export function createMockContext(options: MockContextOptions = {}): AgentContext {
  return {
    core: { ...DEFAULT_CORE_MOCK, ...options.core },
    // ...
  };
}
```

---

## Recommended Actions

### Phase 1: Critical Fixes (Low Risk, High Value)

| Priority | Action | File | Impact |
|----------|--------|------|--------|
| **P0** | Fix Date serialization | `src/context/child/ipc-helpers.ts` | Prevents runtime errors |
| **P0** | Add round-trip tests | `src/tests/context/serialization.test.ts` | Verifies fix |
| **P1** | Extract issue formatters | `src/context/shared/format-issue.ts` | Eliminates 120 lines duplication |
| **P1** | Add CoreModule.getMode() | `src/types.ts` | Interface consistency |

### Phase 2: Testing Infrastructure (Medium Risk)

| Priority | Action | File | Impact |
|----------|--------|------|--------|
| **P2** | Create IPC test harness | `src/tests/test-utils/ipc-harness.ts` | Enables integration testing |
| **P2** | Add ChildIssue tests | `src/tests/context/child-issue.test.ts` | Tests IPC paths |
| **P2** | Add serialization tests | `src/tests/context/serialization.test.ts` | Catches IPC bugs |

### Phase 3: Architecture Improvements (Consider Carefully)

| Priority | Action | Risk | Benefit |
|----------|--------|------|---------|
| **P3** | Split WikiManager | Medium | Better testability |
| **P3** | Make Loader silent mode explicit | Low | Removes hidden behavior |
| **P4** | IPC proxy pattern | Medium | Reduces boilerplate |
| **P4** | Add ChildContext caching | Low | Reduces IPC overhead |

### Not Recommended (Architect's Veto)

❌ **Merge ParentContext and ChildContext** - different ownership semantics, would obscure important distinction

❌ **Replace IPC wrappers with Proxy magic** - loses type safety, harder to debug

❌ **Collapse BaseCore into composition** - adds complexity without clear benefit, shallow inheritance is fine

---

## Implementation Order

### Sprint 1: Critical Fixes
1. Add Date deserialization to `ipc-helpers.ts`
2. Create `format-issue.ts` in shared/
3. Update IssueManager and ChildIssue to use shared formatter
4. Add `getMode()` to CoreModule interface

### Sprint 2: Testing
1. Create `ipc-harness.ts` test utility
2. Add serialization round-trip tests
3. Add ChildIssue/ChildWiki integration tests
4. Add deep partial support to mock-context.ts

### Sprint 3: Improvements (Optional)
1. Split WikiManager into services
2. Add caching to ChildContext modules
3. Consider IPC proxy for new modules only

---

## Files Analyzed

| File | Lines | Issues Found |
|------|-------|--------------|
| `context/shared/base-core.ts` | 116 | Thin but acceptable |
| `context/parent/core.ts` | 279 | Implementation-only getMode() |
| `context/child/core.ts` | 106 | Missing Date deserialization |
| `context/parent/issue.ts` | 160 | **120 lines duplicated formatting** |
| `context/child/issue.ts` | 120 | **Duplicate + IPC bug risk** |
| `context/parent/wiki.ts` | 733 | Too complex, needs split |
| `context/child/wiki.ts` | 165 | Missing Date deserialization |
| `context/parent-context.ts` | 329 | 200+ lines IPC handlers |
| `context/child-context.ts` | 64 | Clean composition root |
| `tests/test-utils/mock-context.ts` | 238 | No IPC support, needs deep partial |

---

## Appendix: Team Member Quotes

**dev-aggressive**:
> "The code works, but it's accumulating technical debt. The presentation logic duplication is the worst offender - fix that NOW."

**architect-conservative**:
> "The architecture is sound. I would oppose any aggressive refactoring that merges contexts or replaces IPC wrappers with magic."

**harness-specialist**:
> "If your architecture needs 238 lines of test utilities just to create mocks, your architecture is too complex."

---

## Decision Log

| Decision | Reasoning |
|----------|-----------|
| Keep BaseCore inheritance | Shallow 2-level hierarchy, genuine is-a relationship, migration cost > benefit |
| Extract formatting to shared | All 3 specialists flagged this, immediate win, eliminates bugs |
| Fix Date serialization first | P0 bug affecting all child processes, easy to fix |
| Add IPC test harness | Critical gap in test coverage, enables integration testing |
| Defer IPC proxy pattern | Architect vetoed for losing type safety, consider for new modules only |
| Defer WikiManager split | P3 priority, requires careful planning |

---

## Next Steps

1. **Create issues** for each Phase 1 action
2. **Estimate effort** for Phase 2 (testing infrastructure)
3. **Schedule Sprint 1** for critical fixes
4. **Review Phase 3** in next architecture meeting

---

*Document generated from team discussion on 2026-05-06*