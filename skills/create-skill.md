---
name: create-skill
description: "Guide for creating new skills that capture domain knowledge and best practices. Use this when documenting lessons learned or creating reusable knowledge."
tags: [skill, knowledge, documentation, workflow, best-practices]
---

# How to Create a Skill

Skills capture reusable knowledge that helps the agent perform tasks better. This guide shows how to create effective skills.

## What is a Skill?

A skill is a markdown file that documents:
- **Domain knowledge** - Facts and concepts about a topic
- **Procedures** - Step-by-step workflows
- **Best practices** - Lessons learned from experience
- **Reference material** - Quick lookup information

Skills start in `.mycc/skills/` directory for testing, then migrate to `skills/` when qualified.

## When to Create a Skill

Create a skill when:
1. You completed a complex task and learned important lessons
2. You researched a topic and found useful information
3. You made mistakes that could be avoided with better guidance
4. You notice patterns that should be documented

**Example**: After writing API documentation, create a skill about "how to write good API docs".

## Skill File Structure

### Frontmatter (Required)

```yaml
---
name: skill-name
description: "Brief description of what this skill provides. Use this when [situation]."
tags: [tag1, tag2, tag3]
---
```

**Fields:**
- `name`: Lowercase with hyphens, matches filename
- `description`: One sentence explaining when to use. Start with action verb.
- `tags`: Keywords for discovery (optional but recommended)

### Content Sections

Organize content with clear sections:

```markdown
# Main Topic

## Overview
Brief introduction and when to use.

## Section 1
Content with examples.

## Section 2
More content.

## Common Pitfalls
What to avoid.

## Checklist
Quick reference for verification.
```

## Good Skill vs Bad Skill

### Bad Skill: Too Vague

```markdown
---
name: coding
description: "Guide for coding."
---

# Coding

Write good code. Test it. Deploy it.
```

**Problems:**
- No actionable information
- No examples
- No specific guidance

### Good Skill: Specific and Actionable

```markdown
---
name: coding
description: "Best practices for writing maintainable code. Use when starting new features or refactoring."
tags: [code, quality, maintainability]
---

# Code Writing Best Practices

## 1. Function Design

Keep functions under 50 lines. If longer, split into smaller functions.

```typescript
// BAD: 100-line function
function processData(data: any) {
  // 100 lines of logic
}

// GOOD: Split into focused functions
function processData(data: any) {
  const validated = validateInput(data);
  const transformed = transformData(validated);
  return saveResults(transformed);
}
```

## 2. Error Handling

Always handle errors with context:

```typescript
// BAD: Silent failure
try {
  await saveData();
} catch (e) {
  console.log(e);
}

// GOOD: Contextual error handling
try {
  await saveData();
} catch (e: unknown) {
  const error = e as Error;
  ctx.core.brief('error', 'saveData', `Failed to save: ${error.message}`);
  throw new SaveError('data', error.message);
}
```

## Checklist

- [ ] Functions under 50 lines
- [ ] Errors handled with context
- [ ] No hardcoded values
- [ ] Tests for critical paths
```

## Key Principles

### 1. Be Specific

**Vague:** "Use good variable names."

**Specific:** "Use descriptive names that explain purpose: `userCount` not `x`, `isValidEmail` not `flag`."

### 2. Show Examples

Every principle should have a code example showing good and bad:

```typescript
// BAD: Doesn't explain why
if (x) return true;

// GOOD: Clear intent
if (user.hasPermission('admin')) {
  return true;
}
```

### 3. Provide Checklists

End with actionable checklist:

```markdown
## Verification Checklist

- [ ] All response fields documented
- [ ] Examples tested and working
- [ ] Error cases covered
```

### 4. Include Common Pitfalls

Document mistakes to avoid:

```markdown
## Common Pitfalls

### Pitfall 1: Forgetting to Handle Errors

Problem: Code crashes without helpful message.
Solution: Wrap in try-catch with context.
```

### 5. Reference External Resources

Link to official docs when relevant:

```markdown
## Resources

- Official docs: https://example.com/docs
- GitHub repo: https://github.com/example/project
```

## Skill Categories

### Process Skills

Document workflows and procedures:

```markdown
# Code Review Process

## Step 1: Security Check
Check for vulnerabilities...

## Step 2: Code Quality
Review naming, structure...

## Step 3: Performance
Look for N+1 queries...
```

### Reference Skills

Provide quick lookup information:

```markdown
# API Reference Quick Guide

## Common Response Fields

| Field | Type | Description |
|-------|------|-------------|
| done | boolean | Is generation complete? |
| eval_count | number | Tokens generated |
```

### Lesson Skills

Capture lessons from experience:

```markdown
# Lessons from Writing API Docs

## What Went Wrong

We documented tool calling but forgot:
1. The `id` field in tool_calls
2. The `index` field for parallel calls
3. Complete cycle (not just initial call)

## How We Fixed It

Ran experiments to find missing fields...
```

## Workflow for Creating Skills

### Step 1: Complete a Task

Work on something substantial that involves learning.

### Step 2: Identify Lessons

Ask yourself:
- What did I learn?
- What mistakes did I make?
- What would I do differently?
- What should be documented?

### Step 3: Create the Skill File

```bash
# ALWAYS create in .mycc/skills/ first for testing
.mycc/skills/my-new-skill.md
```

**IMPORTANT**: Never create skills directly in `skills/` directory. Always start in `.mycc/skills/` for iterative testing and feedback.

### Step 4: Test and Iterate

1. Let the user test the skill manually
2. Iterate based on feedback
3. Only migrate to `skills/` when the user explicitly agrees the skill is ready

### Step 5: Migrate When Approved

When the user confirms the skill is qualified:

```bash
# Move from .mycc/skills/ to skills/
mv .mycc/skills/my-new-skill.md skills/my-new-skill.md
```

### Step 6: Write with Structure

```markdown
---
name: my-new-skill
description: "When to use and what it provides."
tags: [relevant, tags]
---

# Skill Title

## Overview
Brief intro.

## Main Content
...

## Common Pitfalls
...

## Checklist
...
```

### Step 7: Include Real Examples

Use actual code from your work:

```typescript
// This actually happened:
const response = await ollama.chat({...});
// Response had `thinking` field we didn't expect
```

## Skill Naming Conventions

- Use lowercase with hyphens: `tech-doc-writing.md`, not `TechDocWriting.md`
- Be descriptive: `create-skill.md`, not `skill.md`
- Match name in frontmatter: filename and `name:` should match

## Quality Checklist

Before finalizing a skill, verify:

- [ ] Created in `.mycc/skills/` (NOT directly in `skills/`)
- [ ] Clear frontmatter with name, description, tags
- [ ] Specific, actionable advice
- [ ] Code examples for key concepts
- [ ] Common pitfalls documented
- [ ] Verification checklist at end
- [ ] Links to external resources if relevant
- [ ] Consistent formatting throughout
- [ ] No typos or grammar errors

## Anti-Patterns to Avoid

### 0. Creating Directly in skills/

**WRONG**: Creating skill files directly in `skills/` directory.

**RIGHT**: Always start in `.mycc/skills/` for testing, only migrate when user approves.

### 1. Too Generic

"Write good code" is not helpful. Be specific about what good code looks like.

### 2. No Examples

Abstract advice without examples is hard to apply. Always show code.

### 3. Outdated Information

Keep skills updated. If APIs change, update the skill.

### 4. Missing Context

Explain WHY something is important, not just WHAT to do.

### 5. Too Long

Be concise. If skill is too long, split into multiple skills.

## Examples from This Project

### Migration Pattern

All skills follow this lifecycle:
1. **Created in `.mycc/skills/`** - For testing and iteration
2. **Tested manually** - User provides feedback
3. **Migrated to `skills/`** - When user agrees the skill is ready

### tech-doc-writing.md

Captures lessons from creating API documentation:
- How to research (multiple sources, experiments)
- What to include (wire format, complete workflows)
- Common pitfalls (missing fields, incomplete examples)
- Verification checklist

### coordination/SKILL.md

Documents team coordination workflow:
- When to use team mode
- Step-by-step process
- Communication patterns
- Troubleshooting

### add-tool/SKILL.md

Provides template and process for creating tools:
- Two-phase workflow (prototype → migrate)
- Code templates
- Registration process
- Checklist for verification

## Summary

Good skills are:
1. **Specific** - Not vague advice
2. **Actionable** - Reader can apply immediately
3. **Example-rich** - Shows good and bad patterns
4. **Verifiable** - Has checklists
5. **Current** - Up to date with latest practices

When you learn something valuable, create a skill to preserve that knowledge for future use.