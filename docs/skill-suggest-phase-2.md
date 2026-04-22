# Phase 2: Get Skill Suggestion from User Query

## Goal

Build skill hints from wiki matching when user sends a query, and remove skill list from system prompt to reduce distraction while preserving skill visibility.

## Files to Modify

- `src/loop/agent-loop.ts` - Add `buildSkillHint()` helper and call it in main loop
- `src/context/triologue.ts` - Add hint management methods
- `src/config.ts` - Add configurable similarity threshold
- `.env.example` - Document new env variable
- System prompt file - Remove skill list from system prompt

## Implementation

### 2.1 Add Configurable Similarity Threshold

**File: `src/config.ts`**

Add environment variable for skill matching threshold:

```typescript
// Skill matching threshold (0-1), default 0.5
export const SKILL_MATCH_THRESHOLD = parseFloat(process.env['SKILL_MATCH_THRESHOLD'] || '0.5');
```

Update `.env.example`:
```ini
# Skill matching similarity threshold (0-1, default 0.5)
SKILL_MATCH_THRESHOLD=0.5
```

### 2.2 Add Hint Management to Triologue

**File: `src/context/triologue.ts`**

Add temporary hint storage and methods:

```typescript
// Temporary hint (not persisted in transcript)
private temporaryHint: string | null = null;

/**
 * Set temporary hint for current round (not in transcript)
 */
setTemporaryHint(hint: string): void {
  this.temporaryHint = hint;
}

/**
 * Get and clear temporary hint
 */
getAndClearTemporaryHint(): string | null {
  const hint = this.temporaryHint;
  this.temporaryHint = null;
  return hint;
}

/**
 * Reset hint flag for new query
 */
resetHint(): void {
  this.temporaryHint = null;
}
```

### 2.3 Add `buildSkillHint()` Helper

**File: `src/loop/agent-loop.ts`**

Add a helper function to build skill hint using wiki:

```typescript
/**
 * Build skill hint from wiki matching.
 * Only for queries with 5-1000 words (not too short, not too long).
 */
async function buildSkillHint(query: string, ctx: AgentContext): Promise<string | null> {
  const wordCount = query.trim().split(/\s+/).length;
  
  // Skip if query is too short (less than 5 words)
  if (wordCount < 5) {
    ctx.core.verbose('skill-hint', `Query too short (${wordCount} words), skipping`);
    return null;
  }
  
  // Skip if query is too long (rough estimate: 4 chars per token)
  if (query.length > 4000) {
    ctx.core.verbose('skill-hint', 'Query too long for skill matching, skipping');
    return null;
  }

  try {
    ctx.core.verbose('skill-hint', `Searching skills for: "${query.slice(0, 50)}..."`);
    
    const results = await ctx.wiki.get(query, {
      domain: 'skills',
      topK: 3,
      threshold: SKILL_MATCH_THRESHOLD,
    });

    if (results.length === 0) {
      ctx.core.verbose('skill-hint', 'No matching skills found');
      return null;
    }

    ctx.core.verbose('skill-hint', `Found ${results.length} matching skill(s): ${results.map(r => r.document.title).join(', ')}`);

    const hints: string[] = [];
    for (const result of results) {
      const skillName = result.document.title;
      const skillDesc = result.document.content.split('\n').find(line => line.startsWith('Description:'))?.replace('Description: ', '') || '';
      const similarity = (result.similarity * 100).toFixed(0);
      hints.push(`- **${skillName}** (${similarity}% match): ${skillDesc}. Use \`skill_load(name="${skillName}")\` to load it.`);
    }

    return `The following skills may be helpful:\n${hints.join('\n')}`;
  } catch (err) {
    ctx.core.verbose('skill-hint', `Skill matching failed: ${err}`);
    return null;
  }
}
```

### 2.4 Remove Skill List from System Prompt

**File: System prompt (find correct location)**

Remove the skill list from the system prompt. The skill hints will now be dynamically injected based on user queries instead of being statically listed.

### 2.5 Call `buildSkillHint()` in Main Loop

**File: `src/loop/agent-loop.ts`** (in the main loop, after user query)

Find the correct place to:
1. Build skill hint from query
2. Set it in triologue
3. Retrieve it when building LLM context
4. Clear after round completes

```typescript
// Add user message
triologue.user(query);
triologue.resetHint();

// Build and set skill hint
const skillHint = await buildSkillHint(query, ctx);
if (skillHint) {
  triologue.setTemporaryHint(skillHint);
}

// ... LLM context building should include hint from triologue ...

// After round completes
triologue.getAndClearTemporaryHint();
```

### 2.6 Add Startup Warning for Missing Wiki

**File: `src/loop/agent-loop.ts` or appropriate startup location**

Check if wiki is properly configured at startup. If `/skills build` has not been run, show a warning:

```typescript
// At startup, check if skills are indexed
async function checkWikiReady(ctx: AgentContext): Promise<boolean> {
  try {
    const domains = await ctx.wiki.listDomains();
    const skillsDomain = domains.find(d => d.name === 'skills');
    if (!skillsDomain) {
      console.warn('Warning: Skills not indexed. Run /skills build to enable skill suggestions.');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Warning: Wiki not available. Skill suggestions disabled.');
    return false;
  }
}
```

## Verification

1. Run `pnpm typecheck` - should pass
2. Start mycc, run `/skills build` first
3. Send a query: `make a screen-capture tool for me`
4. Check verbose logs for skill matching activity
5. Verify hint appears in LLM context (not in transcript)
6. Test with `SKILL_MATCH_THRESHOLD=0.8` to verify config works
7. Test startup without `/skills build` - should show warning

## Notes

- Skill hints include skill name, similarity percentage, and description
- The system prompt no longer lists all skills (reduces token usage)
- Hints are temporary (not persisted in transcript)
- Threshold is configurable via environment variable