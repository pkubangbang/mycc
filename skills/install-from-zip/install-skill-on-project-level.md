# Install Skill on Project Level

This action file covers installing a detected skill to the **project-level**
skills directory: `.mycc/skills/`. Skills installed here are available only
in the **current project**.

## Prerequisites

Before following these steps, the main `install-from-zip` SKILL.md process
should have already:
- Extracted the zip to a temp directory (Step 3)
- Detected the skill structure and confirmed valid frontmatter (Step 4)
- Obtained user consent for project-level installation (Step 6)
- Checked for name conflicts (Step 6)

You need the **temp directory path** and the **detected skill name**.

## Destination

```
.mycc/skills/
```

This is relative to the current working directory (the project root). The
`.mycc/` directory is project-scoped and typically gitignored.

## Step 1: Ensure the destination directory exists

The project-level skills directory should already exist (mycc creates it
via `ensureDirs()` at startup), but create it defensively in case this is
a fresh project or the directory was removed.

```bash
# Windows PowerShell
$dest = ".mycc\skills"
New-Item -ItemType Directory -Path $dest -Force | Out-Null

# Linux/macOS
dest=".mycc/skills"
mkdir -p "$dest"
```

## Step 2: Check for name conflict

Confirm whether a skill with the same name already exists at the
destination. This should have been checked in the main process (Step 6),
but re-verify here before copying.

```bash
# Windows PowerShell — folder skill
Test-Path (Join-Path $dest "<skillName>")
# Windows PowerShell — single-file skill
Test-Path (Join-Path $dest "<skillName>.md")

# Linux/macOS — folder skill
test -e "$dest/<skillName>" && echo "conflict" || echo "ok"
# Linux/macOS — single-file skill
test -e "$dest/<skillName>.md" && echo "conflict" || echo "ok"
```

If a conflict exists and the user has NOT already confirmed overwrite in
the main process, stop and ask the user. Do not silently overwrite.

**Note on layer priority:** A project-level skill shadows a user-level
skill with the same name (project has higher priority). A built-in skill
cannot be shadowed — if the conflict is with a built-in skill, warn the
user that the project-level install will be ignored by the loader, and
suggest choosing user-level or a different skill name instead.

## Step 3: Copy the skill files

Copy from the temp directory to the destination. The copy form depends on
whether the skill is a single file or a folder.

### Single-file skill

```bash
# Windows PowerShell
Copy-Item "<tmpDir>\<skillName>.md" (Join-Path $dest "<skillName>.md") -Force

# Linux/macOS
cp "<tmpDir>/<skillName>.md" "$dest/"
```

### Folder skill

Copy the entire skill folder (including `SKILL.md` and any sibling
reference files like cheat sheets, examples, etc.).

```bash
# Windows PowerShell
Copy-Item -Recurse "<tmpDir>\<skillName>" (Join-Path $dest "<skillName>") -Force

# Linux/macOS
cp -r "<tmpDir>/<skillName>" "$dest/"
```

### Multi-skill package

Repeat Step 3 for each detected skill. Each skill is copied independently
to the destination.

## Step 4: Compile hookish condition (if applicable)

Check the skill's frontmatter for a `when:` field. If present, the skill
is hookish and its trigger condition must be compiled for the hook to
activate.

Call the `skill_compile` tool:

```
skill_compile(name="<skillName>")
```

If the skill has no `when:` field, skip this step — it is a regular
(process/reference/lesson) skill that is loaded on demand, not via a hook.

## Step 5: Report

After copying (and compiling if applicable), report to the user via
`brief`:

- The skill name
- The final installed path
- Whether condition compilation was performed (for hookish skills)

Then return to the main process for Step 8 (verification) and Step 9
(cleanup).