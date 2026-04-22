# Phase 1: Build Skill Domain

## Goal

Index skills into the wiki under a "skills" domain for semantic matching.

## Files to Modify

- `src/slashes/skills.ts` - NEW: `/skills build` command
- `src/slashes/index.ts` - Register skills command
- `src/context/loader.ts` - Add indexing methods
- `src/tools/skill_load.ts` - Verify-then-update after loading

## Implementation

### 1.1 `/skills build` Slash Command

**File: `src/slashes/skills.ts`** (NEW)

```typescript
import type { SlashCommand, SlashCommandContext } from '../types.js';

export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'Manage skills - list skills, rebuild wiki index',
  handler: async (context: SlashCommandContext) => {
    const { args, ctx } = context;
    
    if (args[0] === 'build') {
      const loader = context.loader; // Need access to loader
      await loader.indexAllSkillsToWiki(ctx.wiki);
      console.log('Skills rebuilt and indexed in wiki.');
      return;
    }
    
    // Default: list skills
    console.log(ctx.skill.printSkills());
  },
};
```

### 1.2 Register in `src/slashes/index.ts`

```typescript
import { skillsCommand } from './skills.js';
// ... existing imports
slashRegistry.register(skillsCommand);
```

### 1.3 Add Indexing Methods to Loader

**File: `src/context/loader.ts`**

Add methods to index skills into wiki:

```typescript
/**
 * Index a skill into wiki under "skills" domain
 * Content = description + keywords + truncated skill body (max 1000 chars)
 */
async indexSkillToWiki(skill: Skill, wiki: WikiModule): Promise<void> {
  // Build content within wiki limits (max 1000 chars)
  const keywordsStr = skill.keywords.length > 0 
    ? `Keywords: ${skill.keywords.join(', ')}\n\n` 
    : '';
  const contentBase = `${skill.description}\n\n${keywordsStr}`;
  const remaining = 1000 - contentBase.length - 50; // buffer for title
  const truncatedContent = skill.content.slice(0, Math.max(0, remaining));
  const content = contentBase + truncatedContent;

  const document: WikiDocument = {
    domain: 'skills',
    title: skill.name,
    content,
    references: [],
  };

  // Check if already indexed with same content
  const existingResults = await wiki.get(skill.name, { domain: 'skills', topK: 1 });
  if (existingResults.length > 0 && existingResults[0].document.title === skill.name) {
    if (existingResults[0].document.content === content) {
      return; // No change needed
    }
    await wiki.delete(existingResults[0].hash);
  }

  const result = await wiki.prepare(document);
  if (result.accepted && result.hash) {
    await wiki.put(result.hash, document);
  }
}

/**
 * Index all skills into wiki (called by /skills build)
 */
async indexAllSkillsToWiki(wiki: WikiModule): Promise<void> {
  await wiki.registerDomain('skills', 'Skills from .mycc/skills/ and skills/');
  
  for (const [name, entry] of this.skills) {
    await this.indexSkillToWiki(entry.skill, wiki);
  }
}
```

### 1.4 Verify-then-Update in skill_load

**File: `src/tools/skill_load.ts`**

After loading a skill, verify and update the wiki index if content changed:

```typescript
handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
  const skillName = args.name as string;
  // ... existing skill loading code ...

  // Verify-then-update: re-index if skill content changed
  const loader = ctx.loader; // Need access to loader
  if (loader && skill) {
    await loader.indexSkillToWiki(skill, ctx.wiki);
  }

  return header + description + keywords + '---\n\n' + skill.content;
}
```

**Note**: This requires adding `loader` reference to AgentContext.

## Verification

1. Run `pnpm build` - should compile
2. Start mycc, run `/skills build`
3. Check wiki domains with `/wiki` - should show "skills" domain