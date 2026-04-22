# Skill Suggestions from Wiki (RAG)

This document describes the implementation of skill suggestions using wiki-based semantic matching, replacing the static skill list in the system prompt.

## Overview

Instead of listing all available skills in the system prompt (which takes tokens and causes distraction), we use the wiki's RAG (Retrieval-Augmented Generation) capability to dynamically suggest relevant skills based on the user's query.

**Benefits:**
- Reduces system prompt token usage
- Only shows relevant skills when needed
- Uses semantic matching for better relevance
- Hints are temporary (not persisted in transcripts)

## Current Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| `/skills build` command | ✅ Implemented | `src/slashes/skills.ts` |
| `loader.indexSkillToWiki()` | ✅ Implemented | `src/context/loader.ts` |
| `loader.indexAllSkillsToWiki()` | ✅ Implemented | `src/context/loader.ts` |
| `getSkillMatchThreshold()` | ✅ Implemented | `src/config.ts` |
| Skill list removed from system prompt | ✅ Done | `src/loop/agent-prompts.ts` |
| `buildSkillHint()` helper | ✅ Implemented | `src/loop/agent-loop-helper.ts` |
| Skill hint integration | ✅ Implemented | `src/loop/agent-repl.ts` |
| `setTemporaryHint()` | ✅ Implemented | `src/loop/triologue.ts` |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     User sends query (agent-repl.ts)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  buildSkillHint(query, ctx) - in agent-repl.ts                  │
│  - Check word count (5-1000 words)                              │
│  - Call ctx.wiki.get(query, {domain: 'skills', topK: 3})        │
│  - Build hint string with skill names and descriptions          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  triologue.setTemporaryHint(hint)                              │
│  - Hint stored in temporaryHint field                          │
│  - NOT added to messages array                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  triologue.user(query) - add user message                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  agentLoop() called                                            │
│  - triologue.getMessages() injects hint as:                    │
│    [hint]...skill suggestions...[/hint]                         │
│    + assistant acknowledgment                                   │
│  - Hint appears in LLM context but NOT in transcript           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  LLM generates response (may call skill_load)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  addMessage() is called → temporaryHint cleared automatically   │
└─────────────────────────────────────────────────────────────────┘
```

## Implemented Components

### 1. Skill Indexing (`/skills build`)

**File:** `src/slashes/skills.ts`

```typescript
export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'Manage skills - list skills, rebuild wiki index',
  handler: async (context) => {
    const { args, ctx } = context;
    
    if (args[0] === 'build') {
      await loader.indexAllSkillsToWiki(ctx.wiki);
      console.log('Skills rebuilt and indexed in wiki.');
      return;
    }
    
    // Default: list skills
    console.log(ctx.skill.printSkills());
  },
};
```

### 2. Skill Indexing in Loader

**File:** `src/context/loader.ts`

```typescript
async indexSkillToWiki(skill: Skill, wiki: WikiModule, layer: Layer): Promise<void> {
  const scope = this.getSkillScope(layer);
  
  // Build content for embedding (scope + name + description + keywords)
  const keywordsStr = skill.keywords.length > 0
    ? ` Keywords: ${skill.keywords.join(', ')}`
    : '';
  const content = `Scope: ${scope}\nName: ${skill.name}\nDescription: ${skill.description}${keywordsStr}`;
  
  // ... wiki prepare and put logic
}

async indexAllSkillsToWiki(wiki: WikiModule): Promise<void> {
  await wiki.registerDomain('skills', 'Skills indexed for semantic matching');
  
  for (const [_name, entry] of this.skills) {
    await this.indexSkillToWiki(entry.skill, wiki, entry.layer);
  }
}
```

### 3. Configuration

**File:** `src/config.ts`

```typescript
export function getSkillMatchThreshold(): number {
  const val = process.env.SKILL_MATCH_THRESHOLD;
  return val ? parseFloat(val) : 0.5;
}
```

**Environment variable:** `SKILL_MATCH_THRESHOLD` (default: 0.5)
- Range: 0.0 to 1.0
- Higher values = stricter matching (fewer results)
- Lower values = looser matching (more results)

### 4. Triologue Temporary Hint (Partially Implemented)

**File:** `src/loop/triologue.ts`

```typescript
// Already implemented:
private temporaryHint: string | null = null;

setTemporaryHint(hint: string): void {
  this.temporaryHint = hint;
}

// getMessages() already injects hint as separate message pair:
// [hint]...skill suggestions...[/hint]
// assistant: "Understood. I will consider the suggested skills..."
```

## Remaining Implementation

All components have been implemented. The system is fully functional.

### Integration Flow

1. **Agent REPL** (`src/loop/agent-repl.ts`) calls `buildSkillHint()` when user sends a query
2. If matching skills found, it calls `triologue.setTemporaryHint(skillHint)`
3. `triologue.getMessages()` injects the hint as a temporary message pair (not in transcript)
4. After the round, hint is automatically cleared when `addMessage()` is called

## Usage

### Indexing Skills

```bash
# In mycc REPL
/skills build
```

This indexes all skills (user, project, built-in) into the wiki under the "skills" domain.

### Skill Hints in Action

1. User sends query: "I need to handle PDF files"
2. Agent loop builds skill hint via wiki matching
3. If PDF-related skills exist, hint appears in LLM context:
   ```
   [hint]The following skills may be helpful:
   - **pdf** (85% match): Process PDF files using npm packages. Use `skill_load(name="pdf")` to load it.
   [/hint]
   ```
4. LLM can then call `skill_load(name="pdf")` to get full skill content
5. Hint is automatically cleared after the round

### Configuration

In `~/.mycc-store/.env`:
```ini
# Skill matching similarity threshold (0-1, default 0.5)
SKILL_MATCH_THRESHOLD=0.5
```

## Key Behaviors

1. **Temporary Storage**: Hint stored in `temporaryHint` field, not in messages array
2. **Auto-clear**: Hint cleared when `addMessage()` is called (new message added)
3. **Transcript-safe**: Hint never appears in saved transcripts (jsonl files)
4. **Threshold-based**: Only shows skills above similarity threshold
5. **Top-K**: Shows at most 3 matching skills
6. **Word filter**: Skips very short (<5 words) or very long (>4000 chars) queries

## Files Modified

| File | Change |
|------|--------|
| `src/slashes/skills.ts` | Added `/skills build` command |
| `src/context/loader.ts` | Added `indexSkillToWiki()`, `indexAllSkillsToWiki()` |
| `src/config.ts` | Added `getSkillMatchThreshold()` |
| `src/loop/agent-prompts.ts` | Removed skill list from system prompt |
| `src/loop/agent-loop-helper.ts` | Added `buildSkillHint()` function |
| `src/loop/agent-repl.ts` | Calls `buildSkillHint()` and `setTemporaryHint()` for user queries |
| `src/loop/triologue.ts` | Has `temporaryHint` field and `setTemporaryHint()` method |
| `docs/skill-suggest.md` | Consolidated documentation (this file) |

## Testing

1. Run `/skills build` to index skills
2. Send a query matching a skill: "help me review code"
3. In verbose mode (`-v`), see skill matching logs
4. Verify hint appears in LLM context
5. Verify hint does NOT appear in transcript file