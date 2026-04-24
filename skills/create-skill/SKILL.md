---
name: create-skill
description: >
  Use this skill when the user requests creation of a new skill. Examples:
  "create a skill for X", "I need a skill to handle Y", "make a skill for Z".
  
  This is a meta-skill that guides the process of creating effective skills.
  Covers skill types (process, reference, lesson), template selection,
  content research, and quality verification.
  
  Related keywords: skill, create, new, template, documentation, knowledge,
  workflow, process, reference, lesson, best-practices.
keywords: [skill, create, template, documentation, knowledge]
---

# Creating Effective Skills

This meta-skill guides you through creating new skills on user request.

## Purpose

Use this skill when:
- User says "create a skill for X"
- User says "I need a skill to handle Y"
- User says "make this knowledge reusable"

This is **NOT** for automatic knowledge distillation after tasks. Only use when explicitly requested.

## Skill Types

Choose the appropriate type based on the skill's purpose:

### Process Skill
Use for step-by-step workflows and procedures.

**Examples:** coordination, add-tool, deployment-workflow

**Template:** `skill-template-process.md`

**Characteristics:**
- Sequential steps
- Commands or code to run
- Decision points
- Verification checkpoints

### Reference Skill
Use for lookup information, formats, configurations.

**Examples:** api-reference, config-format, error-codes

**Template:** `skill-template-reference.md`

**Characteristics:**
- Tables and lists
- Data structures
- Field definitions
- Quick lookup patterns

### Lesson Skill
Use for capturing lessons learned from experience.

**Examples:** tech-doc-writing, troubleshooting-X

**Template:** `skill-template-lesson.md`

**Characteristics:**
- Problems encountered
- Solutions discovered
- Key learnings
- What to do differently

## Skill Creation Process

### Step 1: Gather Requirements

Ask the user:
- **What domain/topic?** - What is the skill about?
- **What problem does it solve?** - When should this skill be used?
- **What type?** - Process, reference, or lesson?
- **Any existing resources?** - Docs, examples, related skills?

### Step 2: Research the Topic

Gather information from multiple sources:

1. **Web search** - Use `web_search` for current information
2. **Wiki search** - Use `wiki_get` for project knowledge
3. **Related skills** - Use `skill_load` to check similar skills
4. **User input** - Ask clarifying questions if needed

Identify:
- Key concepts and terminology
- Common workflows or patterns
- Typical pitfalls and mistakes
- Best practices and recommendations

### Step 3: Select Template

Based on skill type, use the appropriate template:

| Type | Template File |
|------|---------------|
| Process | skill-template-process.md |
| Reference | skill-template-reference.md |
| Lesson | skill-template-lesson.md |

Read the template file to understand the structure.

### Step 4: Write the Skill

#### Frontmatter (Required)

```yaml
---
name: skill-name
description: >
  Detailed description for RAG search. Cover main concepts, use cases,
  related keywords. Explain when to use. Include synonyms.
  
  Token limit: < 800 tokens
keywords: [tag1, tag2, tag3]
---
```

**Important:** The `description` field is for RAG search, not brief summary.
- Cover concepts and use cases
- Include related keywords naturally
- Help semantic search find this skill
- Stay under 800 tokens

#### Content Structure

Follow the template structure for the chosen type:

**Process Skill:**
1. Overview
2. When to Use
3. Process Steps
4. Common Pitfalls
5. Verification Checklist

**Reference Skill:**
1. Overview
2. Reference Categories
3. Tables/Formats
4. Quick Reference
5. Common Patterns

**Lesson Skill:**
1. Context
2. Problems Encountered
3. Solutions Found
4. Key Learnings
5. What to Do Differently

### Step 5: Add Quality Content

#### Be Specific

**Bad:** "Use good variable names."

**Good:** "Use descriptive names that explain purpose: `userCount` not `x`, `isValidEmail` not `flag`."

#### Show Examples

Every principle should have examples:

```typescript
// BAD: Doesn't explain why
if (x) return true;

// GOOD: Clear intent
if (user.hasPermission('admin')) {
  return true;
}
```

#### Document Pitfalls

Include common mistakes and solutions:

```markdown
### Pitfall: Forgetting Error Handling

**Problem:** Code crashes without helpful message.
**Solution:** Wrap in try-catch with context.
```

### Step 6: Create the File

Create the skill in `.mycc/skills/` folder:

1. Create `.mycc/skills/skill-name/` folder
2. Create `SKILL.md` file inside
3. Copy template files if needed
4. Write the skill content

### Step 7: Verify Quality

Check the skill against this checklist:

- [ ] Created in `.mycc/skills/`
- [ ] Clear frontmatter with name, description (< 800 tokens), keywords
- [ ] Matches the appropriate template structure
- [ ] Specific, actionable advice
- [ ] Code examples for key concepts
- [ ] Common pitfalls documented
- [ ] No typos or grammar errors

### Step 8: Present to User

Show the user the created skill and ask for feedback:

```
I've created a skill for [topic] in .mycc/skills/[name]/.

Please review it and let me know:
1. Is the content accurate and complete?
2. Are there any missing sections?
3. Any improvements needed?
```

### Step 9: Iterate

Iterate based on user feedback to improve the skill.

## Naming Conventions

- Use lowercase with hyphens: `tech-doc-writing.md`, not `TechDocWriting.md`
- Be descriptive: `api-error-handling.md`, not `errors.md`
- Match name in frontmatter: filename and `name:` should match

## Quality Guidelines

### Good Skill Characteristics

1. **Specific** - Not vague advice
2. **Actionable** - Reader can apply immediately
3. **Example-rich** - Shows good and bad patterns
4. **Verifiable** - Has checklists
5. **Current** - Up to date with latest practices

### Anti-Patterns to Avoid

1. **Too Generic** - "Write good code" is not helpful
2. **No Examples** - Abstract advice is hard to apply
3. **Outdated** - Keep skills updated with current practices
4. **Missing Context** - Explain WHY, not just WHAT
5. **Too Long** - Be concise; split if too long

## Example Workflow

User: "create a skill for handling docx files"

1. **Gather Requirements:**
   - Topic: Office Word files (docx)
   - Problem: How to read, write, manipulate docx files
   - Type: Process (workflow for handling docx)
   - Resources: Check for existing libraries

2. **Research:**
   - Web search for docx libraries
   - Check wiki for related knowledge
   - Identify key operations: read, write, convert

3. **Select Template:** Process skill

4. **Write Skill:** Follow process template structure

5. **Create File:** `.mycc/skills/docx-handling/SKILL.md`

6. **Verify:** Check quality checklist

7. **Present:** Show to user for feedback

8. **Iterate:** Refine based on feedback

## Summary

Creating skills is a user-initiated process:
1. Gather requirements
2. Research topic
3. Select template (process/reference/lesson)
4. Write quality content
5. Create in `.mycc/skills/`
6. Verify and present
7. Iterate based on feedback

Use the templates in this folder as starting points. Ensure descriptions are detailed for RAG search. Always create skills in `.mycc/skills/`.