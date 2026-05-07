# Custom ESLint Rules

This directory contains custom ESLint rules for the project.

## Rules

### `no-console-in-tools`

**Purpose:** Enforces using `ctx.core.brief()` instead of `console.*` methods in tool implementations.

**Scope:** Only applies to files in `src/tools/` directory.

**Why:** Tools should use `ctx.core.brief()` for output because:
1. It respects the agent's output stream
2. It provides consistent formatting with tool tags
3. It integrates with the agent's logging system
4. It allows output to be captured and processed by the agent loop

**Example:**

❌ **Don't do this:**
```typescript
export default async function myTool(ctx) {
  console.log('Processing...');  // ERROR
  console.error('Failed!');       // ERROR
}
```

✅ **Do this instead:**
```typescript
export default async function myTool(ctx) {
  ctx.core.brief('info', 'my-tool', 'Processing...');
  ctx.core.brief('error', 'my-tool', 'Failed!');
}
```

**Implementation:**
- The rule checks the file path and only activates for files in `src/tools/`
- Disallowed methods: `log`, `error`, `warn`, `info`, `debug`, `trace`, `dir`, `dirxml`, `table`, `assert`
- Files outside `src/tools/` (like `src/index.ts`, `src/ollama.ts`) can still use `console.*` methods

**Testing:**
```bash
# Test on file in src/tools (should fail)
pnpm eslint src/tools/example.ts

# Test on file outside src/tools (should pass)
pnpm eslint src/example.ts
```