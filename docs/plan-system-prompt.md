# Plan: Inject Dynamic Skill Keywords into System Prompt

## Goal

Make the LLM **proactively** use `skill_search` when its current task matches a skill's keywords, by injecting the deduplicated keyword list into the system prompt.

## Approach

The **Loader** (which already owns all skill data) computes a cached, deduplicated, sorted keyword list. The system prompt builder (`buildKnowledgeBoundarySection()`) calls into the Loader to get the list and appends a "Skill Keywords" section. No parameter threading needed.

## Changes

### File 1: `src/context/shared/loader.ts`

**Add cached field + method to `Loader` class:**

```ts
// Field (alongside existing fields like `private tools`, `private skills`)
private _skillKeywords: string[] | null = null;

// Method
getSkillKeywords(): string[] {
  if (this._skillKeywords === null) {
    const allKeywords = new Set<string>();
    for (const [, entry] of this.skills) {
      for (const kw of entry.skill.keywords) {
        allKeywords.add(kw);
      }
    }
    this._skillKeywords = [...allKeywords].sort();
  }
  return this._skillKeywords;
}
```

**Reset cache in `loadAll()`:**

```ts
async loadAll(): Promise<void> {
  this._skillKeywords = null;  // reset cache when skills are (re)loaded
  ensureDirs();
  // ... rest of existing logic unchanged ...
}
```

### File 2: `src/loop/agent-prompts.ts`

**In `buildKnowledgeBoundarySection()`:**

1. Add import at top of file:
   ```ts
   import { loader } from '../context/shared/loader.js';
   ```

2. Append at the end of the function (after "Special notice" paragraph), before the closing `}`:
   ```ts
   // Skill keywords section
   const keywords = loader.getSkillKeywords();
   if (keywords.length > 0) {
     lines.push('');
     lines.push('### Skill Keywords');
     lines.push('');
     lines.push(`Available skill keywords: \`${keywords.join('`, `')}\``);
     lines.push('');
     lines.push('If your current task is relevant to or exactly matches any of these keywords, **proactively** use `skill_search(search="<keyword>")` to discover relevant skills before proceeding with a generic approach.');
   }
   ```

### No changes needed to:

- `llm.ts` — no parameter threading
- `teammate-worker.ts` — no parameter threading
- Any of the 5 prompt builder function signatures
- Any test files (the section is conditionally empty when no skills are loaded, so existing tests pass)

## Design Properties

| Property | How it's achieved |
|---|---|
| **Dynamic** | Keywords come from actual loaded skills at runtime |
| **Prompt cache preserved** | Same string produced every call — no variance |
| **Cached per load cycle** | `_skillKeywords` computed once, reset on `loadAll()` |
| **Hot-reload compatible** | A watcher-triggered reload could call `loadAll()` → cache reset |
| **No param threading** | `buildKnowledgeBoundarySection()` calls Loader directly |
| **All prompts covered** | Shared function used by solo/team, plan/normal, teammate prompts |
| **No circular deps** | `agent-prompts.ts` → `loader.ts` → `agent-io.ts` is acyclic |

## Implementation Steps

1. **Edit** `src/context/shared/loader.ts` — add `_skillKeywords` field, `getSkillKeywords()` method, and reset in `loadAll()`
2. **Edit** `src/loop/agent-prompts.ts` — add import and append Skill Keywords section to `buildKnowledgeBoundarySection()`
3. **Run** `pnpm test` to verify nothing breaks