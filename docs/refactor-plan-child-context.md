# Refactor Plan: Child-Context Parallel to Parent-Context

## Goal Definition

Restructure the context architecture so that `ChildContext` and `ParentContext` are parallel implementations of `AgentContext`, rather than having `ChildContext` nested inside a subdirectory. This improves code organization, makes the relationship between the two contexts clearer, and simplifies imports.

---

## Current Structure

```
src/context/
├── index.ts              # ParentContext + re-exports
├── core.ts               # Core (parent implementation)
├── issue.ts              # IssueManager (parent implementation)
├── bg.ts                 # BackgroundTasks (shared - both use)
├── wt.ts                 # WorktreeManager (parent implementation)
├── team.ts               # TeamManager (parent implementation)
├── wiki.ts               # WikiManager (parent implementation)
├── todo.ts               # Todo (shared - both use)
├── mail.ts               # MailBox (shared - both use)
├── loader.ts             # Loader (shared - both use)
├── memory-store.ts
├── worktree-store.ts
├── teammate-worker.ts
└── child-context/        # ← NESTED subdirectory
    ├── index.ts          # ChildContext
    ├── core.ts           # ChildCore (IPC wrapper)
    ├── issue.ts          # ChildIssue (IPC wrapper)
    ├── wt.ts             # ChildWt (IPC wrapper)
    ├── team.ts           # ChildTeam (IPC wrapper)
    ├── wiki.ts           # ChildWiki (IPC wrapper)
    ├── ipc-helpers.ts    # IPC primitives
    └── ipc-registry.ts   # IPC handler registry
```

### Problems with Current Structure

1. **Asymmetric organization**: Parent implementations are flat files, child implementations are in a subdirectory
2. **Unclear relationship**: The parallel nature of `ParentContext` and `ChildContext` is not obvious
3. **Deep imports**: `import { ChildContext } from './child-context/index.js'`

---

## Target Structure

```
src/context/

├── parent-context.ts           # ParentContext class
├── child-context.ts            # ChildContext class
├── parent/                     # Parent implementations
│   ├── core.ts                 # Core
│   ├── issue.ts                # IssueManager
│   ├── wt.ts                   # WorktreeManager
│   ├── team.ts                 # TeamManager
│   └── wiki.ts                 # WikiManager
├── child/                      # Child implementations (IPC wrappers)
│   ├── core.ts                 # ChildCore
│   ├── issue.ts                # ChildIssue
│   ├── wt.ts                   # ChildWt
│   ├── team.ts                 # ChildTeam
│   ├── wiki.ts                 # ChildWiki
│   └── ipc-helpers.ts          # IPC primitives
├── shared/                     # Shared implementations (used by both)
│   ├── todo.ts                 # Todo
│   ├── mail.ts                 # MailBox
│   ├── bg.ts                   # BackgroundTasks
│   └── loader.ts               # Loader
├── ipc-registry.ts             # IPC handler registration (used by parent)
├── memory-store.ts
├── worktree-store.ts
└── teammate-worker.ts
```

### Key Changes

| Before | After |
|--------|-------|
| `src/context/index.ts` contains `ParentContext` | `src/context/parent-context.ts` contains `ParentContext` |
| `src/context/child-context/` subdirectory | `src/context/child/` subdirectory |
| `src/context/core.ts` | `src/context/parent/core.ts` |
| `src/context/issue.ts` | `src/context/parent/issue.ts` |
| `src/context/todo.ts` (used by both) | `src/context/shared/todo.ts` |
| Deep import for ChildContext | Direct import: `./child-context.js` |
| `index.ts` as entry point | `index.ts` deleted - direct imports |

---

## Task Breakdown

### Phase 1: Create Directory Structure

**Task 1.1: Create new directories**
- Create `src/context/parent/`
- Create `src/context/child/`
- Create `src/context/shared/`

**Task 1.2: Move shared modules**
- Move `todo.ts` → `shared/todo.ts`
- Move `mail.ts` → `shared/mail.ts`
- Move `bg.ts` → `shared/bg.ts`
- Move `loader.ts` → `shared/loader.ts`
- Update all imports referencing these files

### Phase 2: Restructure Parent Context

**Task 2.1: Move parent implementations**
- Move `core.ts` → `parent/core.ts`
- Move `issue.ts` → `parent/issue.ts`
- Move `wt.ts` → `parent/wt.ts`
- Move `team.ts` → `parent/team.ts`
- Move `wiki.ts` → `parent/wiki.ts`

**Task 2.2: Create parent-context.ts**
- Extract `ParentContext` class from `index.ts`
- Create new file `parent-context.ts`
- Update imports to use `./parent/` modules

### Phase 3: Restructure Child Context

**Task 3.1: Move child implementations**
- Move `child-context/index.ts` → `child-context.ts`
- Move `child-context/core.ts` → `child/core.ts`
- Move `child-context/issue.ts` → `child/issue.ts`
- Move `child-context/wt.ts` → `child/wt.ts`
- Move `child-context/team.ts` → `child/team.ts`
- Move `child-context/wiki.ts` → `child/wiki.ts`
- Move `child-context/ipc-helpers.ts` → `child/ipc-helpers.ts`

**Task 3.2: Update child imports**
- Update `ChildContext` imports to use `./child/` modules

### Phase 4: Update Consumer Imports

**Task 4.1: Update imports for ParentContext**
- `src/loop/agent-repl.ts`: `import { ParentContext } from '../context/parent-context.js'`
- `src/loop/agent-loop.ts`: `import { loader } from '../context/shared/loader.js'`

**Task 4.2: Update imports for ChildContext**
- `src/context/teammate-worker.ts`: `import { ChildContext } from './child-context.js'`

**Task 4.3: Update imports for shared modules**
- `src/tools/*.ts`: `import { loader } from '../context/shared/loader.js'`
- `src/slashes/*.ts`: Same as above

**Task 4.4: Delete old files**
- Delete `src/context/index.ts`
- Delete `src/context/child-context/` directory after moving files

### Phase 5: Testing and Verification

**Task 5.1: Run typecheck**
```bash
pnpm typecheck
```

**Task 5.2: Run tests**
```bash
pnpm test
```

**Task 5.3: Run linting**
```bash
npx eslint src/context/
```

**Task 5.4: Manual testing**
- Start mycc
- Create a teammate
- Verify teammate can work

---

## Acceptance Criteria

1. ✅ `ParentContext` and `ChildContext` are in parallel files at `src/context/parent-context.ts` and `src/context/child-context.ts`
2. ✅ Parent implementations are in `src/context/parent/`
3. ✅ Child implementations are in `src/context/child/`
4. ✅ Shared modules are in `src/context/shared/`
5. ✅ All imports updated to direct paths (no index.ts re-exports needed)
6. ✅ TypeScript compiles without errors
7. ✅ All tests pass
8. ✅ ESLint passes
9. ✅ Application starts and functions correctly

---

## Potential Impact to Existing Code

### Files to Update (import paths)

| File | Change |
|------|--------|
| `src/lead.ts` | Update import for `ParentContext` |
| `src/loop/agent-loop.ts` | Update imports for shared modules |
| `src/loop/agent-repl.ts` | Update imports |
| `src/context/teammate-worker.ts` | Update import for `ChildContext` |
| `src/tools/*.ts` | Update imports for context types |
| Any test files | Update imports |

### Breaking Changes

None - this is purely an internal refactoring. The public API (`AgentContext` interface) remains unchanged.

### Risks

1. **Import path breakage** - Must update all import statements carefully
2. **Circular dependencies** - Watch for circular imports when reorganizing
3. **Build system** - May need to verify build still works

---

## Bold Guess on Next Steps

After this refactoring, potential follow-up improvements:

1. **Extract IPC types** - Create `src/context/ipc-types.ts` for all IPC message types
2. **Add factory pattern** - `createParentContext()` and `createChildContext()` factory functions
3. **Document architecture** - Update `docs/child-context.md` with new structure
4. **Consider base class** - If shared logic between contexts grows, extract to `BaseContext`

---

## PEX: Understanding the Refactoring

1. **Current state**: `ParentContext` is defined inline in `index.ts`, while `ChildContext` is in `child-context/index.ts` - this asymmetry is confusing.

2. **Problem**: The nested `child-context/` directory makes it seem like child context is a subfeature, when it's actually a parallel implementation.

3. **Solution**: Move both contexts to the same level (`parent-context.ts` and `child-context.ts`), with their implementations in parallel subdirectories (`parent/` and `child/`).

4. **Shared modules**: Modules like `Todo`, `MailBox`, and `Loader` are used by both contexts and should be in a `shared/` directory.

5. **Import structure**: After refactoring, importing will be cleaner: `import { ParentContext } from './parent-context.js'` and `import { ChildContext } from './child-context.js'`.

6. **No API changes**: The `AgentContext` interface remains the contract; this is purely internal reorganization.

7. **IPC registry stays top-level**: `ipc-registry.ts` is used by the parent context to register handlers, so it stays at the top level of `src/context/`.

---

## Execution Order

```
Phase 1 (directories + shared)
    ↓
Phase 2 (parent restructure)
    ↓
Phase 3 (child restructure)
    ↓
Phase 4 (clean up + re-exports)
    ↓
Phase 5 (test & verify)
```

Each phase should be committed separately for easier rollback if issues arise.