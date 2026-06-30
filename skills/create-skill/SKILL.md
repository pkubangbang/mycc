---
name: create-skill
description: >
  Use when the user requests creation of a new skill. Examples: "create a
  skill for X", "I need a skill to handle Y", "make a skill for Z", "make
  this knowledge reusable". This is a meta-skill that guides the entire
  skill creation process: gathering requirements (domain, problem, type),
  researching the topic via web_search and wiki_get, selecting the
  appropriate template from four types (process for step-by-step workflows,
  reference for lookup information and formats, lesson for captured
  experiences, hookish for auto-triggering skills with when conditions),
  writing quality content with specific examples and documented pitfalls,
  creating the file in .mycc/skills/, and verifying against a quality
  checklist. Covers frontmatter best practices: detailed descriptions for
  RAG semantic search (<800 tokens), keyword selection for discoverability,
  and when field usage for hookish skills. Also covers naming conventions
  (lowercase-hyphenated), anti-patterns to avoid, and iteration based on
  user feedback. Do NOT use for automatic knowledge distillation after
  tasks — only when explicitly requested.
keywords: [skill, create, new, template, documentation, knowledge, meta, process, reference, lesson, hookish, frontmatter, RAG, "best practice", discoverability, reusable]
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

### Hookish Skill
Use for skills that trigger automatically based on conditions (hooks).

**Examples:** lint-typecheck-after-edit, auto-format-on-save

**Template:** `skill-template-hookish.md`

**Characteristics:**
- Clear trigger condition in "when" field
- Actions documented in content section
- No duplication between description and "when"
- Specific, actionable trigger conditions

**Important:** Hookish skills have a `when` field in the frontmatter that defines WHEN the skill triggers. This field should contain ONLY the trigger condition, NOT the actions to take.

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
| Hookish | skill-template-hookish.md |

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
when: trigger condition (only for hookish skills)
---
```

**Important:** The `description` field is for RAG search, not brief summary.
- Cover concepts and use cases
- Include related keywords naturally
- Help semantic search find this skill
- Stay under 800 tokens

**For Hookish Skills Only:** The `when` field defines WHEN the skill triggers.
- Must contain ONLY the trigger condition
- Do NOT include actions in the "when" field
- Be specific about timing and conditions
- Example: `before LLM finishes reply (no tool calls pending), if edit_file or write_file was used this session`

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

**Hookish Skill:**
1. Overview
2. Trigger Condition (in "when" field, NOT in content)
3. Actions
4. When to Use
5. Common Pitfalls
6. Verification Checklist

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

### Step 6: Create the Skill File(s)

Create the skill in `.mycc/skills/` folder. There are two ways to organize a skill:

#### Option A: Single-File Skill (Simple Skills)

For small, self-contained skills, create a single `SKILL.md` file directly in the skills directory:

```
.mycc/skills/
└── my-skill.md              # 单文件，所有内容都在此
```

**When to use:** Small skills (< 200 lines), no supporting files needed, simple reference or lesson.

#### Option B: Folder + SKILL.md (Structured Skills)

For larger skills that benefit from a directory structure, create a folder with `SKILL.md` as the entry point, and reference other files from it:

```
.mycc/skills/
└── my-skill/                # 文件夹
    ├── SKILL.md             # 入口文件，引用其他文件
    ├── cheatsheet-a.md      # 被引用的速查表
    ├── cheatsheet-b.md      # 被引用的速查表
    └── examples/            # 子目录
        └── sample.txt
```

**When to use:** Large skills (> 200 lines), multiple reference files, cheat sheets, examples, or any content that benefits from separation.

**How to reference:** In `SKILL.md`, use relative links to reference sibling files:

```markdown
## Reference: Cheat Sheets

- [PowerShell Cheat Sheet](./powershell-cheatsheet.md)
- [Bash Cheat Sheet](./bash-cheatsheet.md)
- [CMD Cheat Sheet](./cmd-cheatsheet.md)
```

**How the agent loads it:** When the agent loads the skill via `skill_load(name="my-skill")`, it reads `SKILL.md` from the folder. The referenced files are available alongside it — the agent can read them using `read_file` as needed.

**Steps for folder-based skills:**

1. Create `.mycc/skills/skill-name/` folder
2. Create `SKILL.md` file inside as the entry point
3. Create supporting files (cheatsheets, examples, etc.) alongside it
4. In `SKILL.md`, use relative links to reference the supporting files
5. Copy template files if needed
6. Write the skill content

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

- Use lowercase with hyphens: `tech-doc-writing.md` or `tech-doc-writing/SKILL.md`, not `TechDocWriting.md`
- Be descriptive: `api-error-handling.md`, not `errors.md`
- Match name in frontmatter: filename/folder name and `name:` should match
- For folder-based skills: the folder name is the skill name (e.g., `my-skill/`), and the entry file is always `SKILL.md`

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

5. **Create Files:**
   - Option A (simple): `.mycc/skills/docx-handling.md`
   - Option B (structured): `.mycc/skills/docx-handling/SKILL.md` + supporting files

6. **Verify:** Check quality checklist

7. **Present:** Show to user for feedback

8. **Iterate:** Refine based on feedback

## Summary

Creating skills is a user-initiated process:
1. Gather requirements
2. Research topic
3. Select template (process/reference/lesson)
4. Write quality content
5. Create in `.mycc/skills/` (single `SKILL.md` file, or folder with `SKILL.md` + supporting files)
6. Verify and present
7. Iterate based on feedback

Use the templates in this folder as starting points. Ensure descriptions are detailed for RAG search. Always create skills in `.mycc/skills/`.

**Choosing between single-file and folder:**
- **Single file** (`my-skill.md`): Simple, self-contained skills under ~200 lines
- **Folder** (`my-skill/SKILL.md` + files): Larger skills with cheat sheets, examples, or multiple reference files that benefit from separation

## Related Skills

### Understanding Skill Layers

Skills can be created at two user-facing layers with different scopes and priorities:

| Layer | Path | Scope | Priority |
|-------|------|-------|----------|
| **Project** | `.mycc/skills/` | Current project only | Higher (shadows user) |
| **User** | `~/.mycc-store/skills/` | All projects for current user | Lower (shadowed by project) |

- **Prototype** new skills in `.mycc/skills/` (project-level) for testing
- **Share** across projects by placing in `~/.mycc-store/skills/` (user-level)

For detailed detection of available skill layers and their current contents, use the **`environment-detection`** skill (`skill_load(name="environment-detection")`). It provides commands to list project-level and user-level skills, explains the priority ordering, and covers common pitfalls about confusing layers.