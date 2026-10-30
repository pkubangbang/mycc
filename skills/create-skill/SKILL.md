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
8. **Reload mycc** — see [Reloading the new skill](#reloading-the-new-skill). A user-level skill does not take effect until mycc is restarted; say so explicitly in your final report instead of implying it is live.
9. **Present to user** — show the skill, ask for feedback.
10. **Iterate** — refine based on feedback.

## Reloading the new skill

A skill file is read from disk by the loader, but **the running process does not
always pick it up**. State the truth about the location you chose:

| Where the skill was created | Visible to the current session? | How it becomes available |
|---|---|---|
| Project `.mycc/skills/` (single file or `<name>/SKILL.md`) | Yes — the loader watches this directory recursively | Saved file is loaded by the watcher; `skill_load(name="...")` then works |
| User `~/.mycc-store/skills/` (single file or `<name>/SKILL.md`) | **No** — user skills are loaded once at startup and are *not* watched | **Restart mycc** (start a new instance); the skill appears in the new session's `skill_search`/`skill_load` |
| Built-in `skills/` (ships with the package) | No | New process, or ship it with the package |

Rules:

- **Never claim a user-level skill is loaded.** After writing one, verify the
  frontmatter parses (e.g. run gray-matter on the file) and tell the user
  plainly: "written to `~/.mycc-store/skills/<name>/SKILL.md`; it becomes
  available after restarting mycc."
- A failed `skill_load` / empty `skill_search` for a file you just wrote under
  `~/.mycc-store/skills/` is **expected**, not a format bug — check the
  location and startup rule before touching the file.
- `/skills build` reloads skills from disk inside a running session (project
  and user roots); recommend it when the user wants the skill available
  without a restart.
- Hookish skills additionally need their `when` condition compiled in the
  process that loads them (`skill_compile`); a restart re-compiles, so a
  restart is also the clean way to re-arm a changed trigger.

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

> **⚠️ Lead with FUNCTION, not mechanics.** The `description` is surfaced to
> the agent (and the user) in `[HINT] New relevant skills:` nudges, so its
> framing directly shapes how the skill is understood and reached for. Open
> with one sentence stating **what the skill does for the user/agent and when
> to reach for it** — the *function*. Demote internal trigger mechanics
> (guards, counters, hook actions, `session.count(...)` predicates, scoping)
> to a trailing clause ("Fires when…"). A description that leads with
> "Hookish skill that fires when X and guards against Y…" teaches the reader
> the skill's plumbing, not its purpose; the reader then mirrors that
> mechanics frame instead of acting on the function. Function-first;
> mechanics-as-detail. Keep all factual content — reorder, don't delete.

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
- [ ] **Reload stated**: project-level → visible now; user-level → told the
      user it needs a mycc restart (or `/skills build`) before it is loaded
- [ ] Clear frontmatter: name, description (< 800 tokens), keywords
- [ ] **Description leads with FUNCTION (what it does / when to reach for it),
      not mechanics** — trigger guards, counters, and hook actions are demoted
      to a trailing "Fires when…" clause, not the lead sentence
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