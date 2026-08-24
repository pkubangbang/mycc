# Writing Quality Content

> **Read this when writing the skill body.** Kept separate from `SKILL.md` so
> it only loads when you actually need writing guidance.

## Be Specific

**Bad:** "Use good variable names."

**Good:** "Use descriptive names that explain purpose: `userCount` not `x`,
`isValidEmail` not `flag`."

## Show Examples

Every principle should have examples:

```typescript
// BAD: Doesn't explain why
if (x) return true;

// GOOD: Clear intent
if (user.hasPermission('admin')) {
  return true;
}
```

## Document Pitfalls

Include common mistakes and solutions:

```markdown
### Pitfall: Forgetting Error Handling

**Problem:** Code crashes without helpful message.
**Solution:** Wrap in try-catch with context.
```

## Good Skill Characteristics

1. **Specific** - Not vague advice
2. **Actionable** - Reader can apply immediately
3. **Example-rich** - Shows good and bad patterns
4. **Verifiable** - Has checklists
5. **Current** - Up to date with latest practices

## Anti-Patterns to Avoid

1. **Too Generic** - "Write good code" is not helpful
2. **No Examples** - Abstract advice is hard to apply
3. **Outdated** - Keep skills updated with latest practices
4. **Missing Context** - Explain WHY, not just WHAT
5. **Too Long** - Be concise; split if too long

## Content Structure by Type

**Process Skill:** Overview → When to Use → Process Steps → Common Pitfalls → Verification Checklist

**Reference Skill:** Overview → Reference Categories → Tables/Formats → Quick Reference → Common Patterns

**Lesson Skill:** Context → Problems Encountered → Solutions Found → Key Learnings → What to Do Differently

**Hookish Skill:** Overview → Trigger Condition (in `when` field, NOT in content) → Actions → When to Use → Common Pitfalls → Verification Checklist