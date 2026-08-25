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
keywords: [skill, create, new, template, documentation, knowledge, meta, process, reference, lesson, hookish, service, daemon, cron, scheduled, background, headless, frontmatter, RAG, "best practice", discoverability, reusable, condition, expression, when, hook, trigger, jsep, evaluator]
---

# Creating Effective Skills

Use this skill when the user asks to create a new skill. **NOT** for automatic
knowledge distillation after tasks — only when explicitly requested.

## Skill Types

| Type | Use for | Template |
|------|---------|---------|
| **Process** | Step-by-step workflows, procedures | `skill-template-process.md` |
| **Reference** | Lookup info, formats, configurations | `skill-template-reference.md` |
| **Lesson** | Captured lessons learned from experience | `skill-template-lesson.md` |
| **Hookish** | Auto-triggering skills based on conditions (hooks) | `skill-template-hookish.md` |
| **Service** | Long-lived headless background workers run via `--daemon` (cron-scheduled or event-driven) | `skill-template-service.md` |

Read the template file to understand the structure for the chosen type.

> **Service skills must be ACTIONABLE.** A service skill runs headless via
> `--daemon` with no human to redirect it, so every cron nudge / external
> mail must tell the LLM exactly what to inspect, what to do, and how to
> report. Vague instructions ("monitor the system") produce a daemon that
> wakes, finds nothing concrete, and idles. Use the
> `skill-template-service.md` template and make Step 1 name an exact
> pending-work signal, Step 2 name exact tools + decision logic, and Step 4
> consume each item so the loop is idempotent.

## Creation Process

1. **Gather requirements** — domain/topic, problem it solves, type, existing resources.
2. **Research** — `web_search` for current info, `wiki_get` for project knowledge, `skill_load` to check similar skills.
3. **Select template** — from the table above.
4. **Write the skill** — frontmatter + content (see below).
5. **Add quality content** — be specific, show examples, document pitfalls. See [Writing Quality Content](./writing-quality-content.md) for detailed guidance.
6. **Create the file** — in `.mycc/skills/`. See [File Organization](./skill-file-organization.md) for single-file vs folder structure.
7. **Verify** — check against the checklist below.
8. **Present to user** — show the skill, ask for feedback.
9. **Iterate** — refine based on feedback.

## Frontmatter (Required)

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

- `description` is for **RAG search**, not a brief summary. Cover concepts and use cases, include related keywords naturally, stay under 800 tokens.
- `keywords` aid discoverability via `skill_search`.

### Hookish `when` field

The `when` field defines WHEN the skill triggers — it must contain ONLY the
trigger condition, NOT the actions to take. Be specific about timing and
conditions. Example: `before LLM finishes reply (no tool calls pending), if edit_file or write_file was used this session`.

The natural-language `when` text is compiled into a structured hook condition by
`skill_compile`. The compiled **condition expression** is a safe subset of
JavaScript evaluated via jsep (AST parsing, no `eval`/`Function`).

> **Writing a hookish `when` condition?** Read the full expression grammar,
> available functions, tool-spec syntax, and worked examples in
> [Condition Expression Reference](./condition-expression-reference.md).

## File Location

Create skills in `.mycc/skills/` (project-level, higher priority) or
`~/.mycc-store/skills/` (user-level, shared across projects). Prototype at
project-level; share by moving to user-level. For single-file vs folder
structure details, see [File Organization](./skill-file-organization.md).

## Naming Conventions

- Lowercase with hyphens: `tech-doc-writing.md` or `tech-doc-writing/SKILL.md`
- Be descriptive: `api-error-handling.md`, not `errors.md`
- Match name in frontmatter: filename/folder name and `name:` should match
- For folder-based skills: folder name is the skill name, entry file is `SKILL.md`

## Verification Checklist

- [ ] Created in `.mycc/skills/` (or `~/.mycc-store/skills/` for user-level)
- [ ] Clear frontmatter: name, description (< 800 tokens), keywords
- [ ] Matches the appropriate template structure
- [ ] Specific, actionable advice with code examples
- [ ] Common pitfalls documented
- [ ] No typos or grammar errors

## On-Demand References

These are kept in separate files so they only load when needed:

- [Writing Quality Content](./writing-quality-content.md) — how to be specific, show examples, document pitfalls
- [File Organization](./skill-file-organization.md) — single-file vs folder+SKILL.md structure, when to use each
- [Condition Expression Reference](./condition-expression-reference.md) — full hookish `when` expression grammar (jsep-based)

## Related Skills

- **`environment-detection`** (`skill_load(name="environment-detection")`) — list project-level and user-level skills, explains layer priority ordering