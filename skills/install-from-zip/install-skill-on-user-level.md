# Install Skill on User Level

This action file covers installing a detected skill to the **user-level**
skills directory: `~/.mycc-store/skills/`. Skills installed here are
available across **all projects** for the current user.

## Prerequisites

Before following these steps, the main `install-from-zip` SKILL.md process
should have already:
- Extracted the zip to a temp directory (Step 3)
- Detected the skill structure and confirmed valid frontmatter (Step 4)
- Obtained user consent for user-level installation (Step 6)
- Checked for name conflicts (Step 6)

You need the **temp directory path** and the **detected skill name**.

## Destination

```
~/.mycc-store/skills/
```

- Windows: `$env:USERPROFILE\.mycc-store\skills\`
- Linux/macOS: `~/.mycc-store/skills/`

## Step 1: Ensure the destination directory exists

The user-level skills directory may not exist yet on a fresh install.

```bash
# Windows PowerShell
$dest = Join-Path $env:USERPROFILE ".mycc-store\skills"
New-Item -ItemType Directory -Path $dest -Force | Out-Null

# Linux/macOS
dest="$HOME/.mycc-store/skills"
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