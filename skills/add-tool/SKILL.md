---
name: add-tool
description: >
  Use this skill when creating new tools for the mycc agent. Provides
  templates, guidelines, and checklist for tool development.
  
  Covers tool structure, parameter validation, error handling, logging,
  scope selection, and best practices.
  
  Keywords: tool, create, add, new, implement, extend, development.
keywords: [tool, development, create, workflow]
---

# Adding a New Tool

## Purpose

Use this skill when:
- User requests "add a tool for X"
- User requests "create a tool that does Y"
- User requests "implement a custom tool"

## Tool Structure

### Required Components

```typescript
{
  name: string,           // Tool identifier (kebab-case)
  description: string,    // What the tool does (for LLM understanding)
  input_schema: object,   // JSON Schema for parameters
  scope: string[],        // Where tool can be used
  handler: function,      // Implementation
}
```

### Export Style

For tools in `.mycc/tools/`:

```typescript
export default { ... } as ToolDefinition;
```

## Creating a Tool

### Step 1: Gather Requirements

Ask the user:
- **What does the tool do?** - Core functionality
- **What parameters?** - Input/output format
- **What scope?** - Where should it be available?
- **Any constraints?** - Safety, permissions, limitations

### Step 2: Use Template

Read the template file: `tool-template.md`

Key sections to customize:
- `name`: kebab-case identifier
- `description`: Clear description for LLM understanding
- `input_schema`: Define all parameters
- `scope`: Set appropriate access level
- `handler`: Implement the logic

### Step 3: Validate Parameters

Always validate required parameters:

```typescript
handler: (ctx: AgentContext, args: Record<string, unknown>): string => {
  const param1 = args.param1 as string;
  
  // Validate required parameters
  if (!param1) {
    return 'Error: param1 is required';
  }
  
  // Continue with implementation
}
```

### Step 4: Add Logging

**ALWAYS log meaningful information:**

```typescript
// DO: Log with context
ctx.core.brief('info', 'tool-name', `Processing ${param1}, ${param2}`);

// DON'T: Be vague
ctx.core.brief('info', 'tool-name', 'working');  // BAD
```

### Step 5: Handle Errors

Wrap logic in try-catch:

```typescript
try {
  const result = await someOperation();
  return `Success: ${result}`;
} catch (error: unknown) {
  const err = error as Error;
  ctx.core.brief('error', 'tool-name', err.message);
  return `Error: ${err.message}`;
}
```

### Step 6: Create File

Create the tool in `.mycc/tools/<name>.ts`

### Step 7: Test

Let user test the tool manually. Iterate based on feedback.

## Scope Selection

| Scope | Use Case | Examples |
|-------|----------|----------|
| `['main', 'child', 'bg']` | Safe read-only tools | bash, read_file |
| `['main', 'child']` | Most tools | write_file, edit_file |
| `['main']` | Sensitive operations | tm_create, tm_remove |

## Input Schema

### String Parameter

```typescript
name: { 
  type: 'string', 
  description: 'The name to process' 
}
```

### Number Parameter

```typescript
count: { 
  type: 'number', 
  description: 'Number of items' 
}
```

### Enum Parameter

```typescript
format: { 
  type: 'string', 
  enum: ['json', 'yaml', 'text'],
  description: 'Output format' 
}
```

### Array Parameter

```typescript
items: { 
  type: 'array',
  items: { type: 'string' },
  description: 'List of items' 
}
```

### Optional Parameter

```typescript
// Don't add to required array
options: { 
  type: 'string', 
  description: 'Optional configuration' 
}
```

## Best Practices

### 1. Be Specific

**Bad:**
```typescript
description: 'Process data'
```

**Good:**
```typescript
description: 'Process CSV files and extract columns by name'
```

### 2. Return Meaningful Results

**Bad:**
```typescript
return 'Done';
```

**Good:**
```typescript
return `Processed ${count} rows, ${success} succeeded, ${failed} failed`;
```

### 3. Use Async for I/O

```typescript
handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
  const result = await someAsyncOperation();
  return result;
}
```

### 4. Type Assertions

```typescript
const param1 = args.param1 as string;
const param2 = args.param2 as number | undefined;
const param3 = args.param3 as string[];
```

## Common Pitfalls

### Pitfall 1: Missing Parameter Validation

**Problem:** Tool crashes when required parameter is missing.

**Solution:** Always validate at the start of handler.

### Pitfall 2: No Logging

**Problem:** Hard to debug what went wrong.

**Solution:** Use `ctx.core.brief()` for meaningful logs.

### Pitfall 3: Wrong Scope

**Problem:** Tool available where it shouldn't be.

**Solution:** Choose minimal scope needed. Use `['main']` for sensitive operations.

### Pitfall 4: Sync Handler for Async Operations

**Problem:** Tool blocks while waiting for I/O.

**Solution:** Use `async` handler for any async operations.

## Checklist

Before considering a tool complete:

- [ ] Created in `.mycc/tools/<name>.ts`
- [ ] Uses `export default { ... } as ToolDefinition`
- [ ] Clear description for LLM understanding
- [ ] All parameters defined in input_schema
- [ ] Required parameters validated
- [ ] Meaningful logging with `ctx.core.brief()`
- [ ] Errors caught and returned with context
- [ ] Appropriate scope selected
- [ ] Tested by user
- [ ] Confirmed working