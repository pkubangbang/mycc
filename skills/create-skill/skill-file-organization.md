# Skill File Organization

> **Read this when creating the skill file(s).** Kept separate from `SKILL.md`
> so it only loads when you actually need structural guidance.

There are two ways to organize a skill in `.mycc/skills/`:

## Option A: Single-File Skill (Simple Skills)

Create a single `SKILL.md` (or `my-skill.md`) file directly in the skills directory:

```
.mycc/skills/
└── my-skill.md              # single file, all content here
```

**When to use:** Small skills (< 200 lines), no supporting files needed, simple
reference or lesson.

## Option B: Folder + SKILL.md (Structured Skills)

Create a folder with `SKILL.md` as the entry point, and reference other files
from it:

```
.mycc/skills/
└── my-skill/                # folder
    ├── SKILL.md             # entry file, references others
    ├── cheatsheet-a.md      # referenced cheat sheet
    ├── cheatsheet-b.md      # referenced cheat sheet
    └── examples/            # subdirectory
        └── sample.txt
```

**When to use:** Large skills (> 200 lines), multiple reference files, cheat
sheets, examples, or any content that benefits from separation.

### How to reference sibling files

In `SKILL.md`, use relative links:

```markdown
## Reference: Cheat Sheets

- [PowerShell Cheat Sheet](./powershell-cheatsheet.md)
- [Bash Cheat Sheet](./bash-cheatsheet.md)
```

### How the agent loads it

`skill_load(name="my-skill")` reads `SKILL.md` from the folder. Referenced files
are available alongside it — the agent reads them with `read_file` as needed.
This is **progressive disclosure**: the backbone stays lean, detail loads on
demand.

### Steps for folder-based skills

1. Create `.mycc/skills/skill-name/` folder
2. Create `SKILL.md` inside as the entry point
3. Create supporting files (cheatsheets, examples, etc.) alongside it
4. In `SKILL.md`, use relative links to reference the supporting files
5. Copy template files if needed
6. Write the skill content

## Choosing

- **Single file** (`my-skill.md`): Simple, self-contained skills under ~200 lines
- **Folder** (`my-skill/SKILL.md` + files): Larger skills with cheat sheets,
  examples, or multiple reference files that benefit from separation