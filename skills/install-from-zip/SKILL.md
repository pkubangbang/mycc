---
name: install-from-zip
description: >
  Guide for installing a skill from a .zip archive. Use when the user
  provides a zip file path and asks to install, import, or load a skill
  from it. Covers cross-platform extraction (Expand-Archive on Windows,
  unzip/tar on Linux/macOS), skill package detection (validates SKILL.md
  or *.md with YAML frontmatter containing a name field), summarizing the
  skill's purpose from its frontmatter description and content, asking
  user consent for installation level (user-level ~/.mycc-store/skills/,
  project-level .mycc/skills/, or temporary one-time use), executing the
  copy via dedicated per-destination action files, and verifying the skill
  loads correctly afterward with skill_load. Handles single-file skills,
  folder skills with SKILL.md, and multi-skill packages. Includes name
  conflict detection with overwrite confirmation, hookish skill condition
  compilation via skill_compile, and mandatory temp directory cleanup.
keywords: [install, zip, archive, extract, skill, package, import,
  unzip, Expand-Archive, tar, user-level, project-level, temporary,
  ad-hoc, SKILL.md, frontmatter, install-from-zip, consent, conflict,
  overwrite, compile]
---

# Install from Zip

## Overview

This skill guides the process of installing a skill from a `.zip` archive.
It covers the full workflow: verifying the zip, extracting it to a
temporary directory, detecting whether the contents form a valid skill
package, summarizing the skill's purpose to the user, asking for consent
and installation level, executing the installation via per-destination
action files, verifying the skill loads, and cleaning up the temp
directory.

## When to Use

- The user provides a `.zip` file path and asks to install, import, or
  load a skill from it.
- The user drops a zip file and says "install this" or "what's in this
  package".
- The user references a skill archive and wants to try or permanently
  install it.

## Process

### Step 1: Verify the zip file exists

Confirm the path the user gave points to a readable `.zip` file.

```bash
# Windows PowerShell
Test-Path "<zipPath>"

# Linux/macOS
test -f "<zipPath>" && echo "exists" || echo "not found"
```

If the file does not exist or is not a `.zip`, tell the user and stop.

### Step 2: Create a temporary directory

Create a unique temp directory to extract into. Do NOT extract in-place.

```bash
# Windows PowerShell
$tmpDir = Join-Path $env:TEMP "mycc-install-$(Get-Random)"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
Write-Output $tmpDir   # remember this path for later steps

# Linux/macOS
tmpDir="/tmp/mycc-install-$$"
mkdir -p "$tmpDir"
echo "$tmpDir"   # remember this path for later steps
```

**Remember the temp directory path** — you need it for extraction,
detection, installation, and cleanup.

### Step 3: Extract the zip (cross-platform)

Detect the platform and use the matching extraction command. mycc runs on
Windows (PowerShell), Linux, and macOS.

**Windows (PowerShell)** — `Expand-Archive` is always available:

```bash
Expand-Archive -Path "<zipPath>" -DestinationPath "<tmpDir>" -Force
```

**Linux/macOS** — prefer `unzip`, fall back to `tar`:

```bash
# Try unzip first
unzip -o "<zipPath>" -d "<tmpDir>" 2>/dev/null || tar -xf "<zipPath>" -C "<tmpDir>"
```

After extraction, verify the temp directory is not empty. If extraction
failed, report the error and skip to Step 9 (cleanup).

### Step 4: Detect skill structure

List the extracted contents and identify skill entrypoint candidates.

```bash
# Windows PowerShell
Get-ChildItem -Recurse "<tmpDir>" | Select-Object FullName, Mode

# Linux/macOS
find "<tmpDir>" -type f
```

**Valid skill entrypoints** (mycc skill layout, enforced by the loader):

| Form | Condition |
|------|-----------|
| **Single-file skill** | A `.md` file at the archive root with YAML frontmatter containing a `name:` field |
| **Folder skill** | A subdirectory at the archive root containing `SKILL.md` with frontmatter containing a `name:` field |
| **Multi-skill package** | Multiple single-file and/or folder skills — all installable |

**Detection procedure:**

1. From the file listing, identify candidate entrypoints:
   - `.md` files directly under the temp root
   - `SKILL.md` files one level under subdirectories
2. For each candidate, use the **`read_file` tool** (NOT `Get-Content` /
   `cat` — see Pitfalls) to read the file.
3. Check the content begins with YAML frontmatter (`---` delimiters) and
   contains a `name:` field. The `name:` field is the only required field
   for a valid skill.
4. Record each valid skill: its `name`, `description`, and whether it has
   a `when:` field (hookish skills need condition compilation later).

**If no valid skill entrypoint is found** — the archive does not contain a
skill package. Tell the user what was found instead and stop. Do not
attempt to install non-skill content.

**If multiple skills are found** — list them all; the user will be asked
about each in Step 6.

### Step 5: Summarize the skill's purpose

For each detected skill, produce a 1-2 sentence summary:

1. Read the `description` field from the frontmatter — this is the primary
   source.
2. Read the first few paragraphs of the content body (Overview / Purpose
   section) if the description is too terse.
3. Synthesize a concise summary the user can quickly evaluate.

### Step 6: Ask for consent and installation level

Present each detected skill and ask the user where to install it. Use
`brief` to report the summary, then ask the user directly.

**Presentation format:**

```
发现技能: <name>
描述: <1-2 sentence summary>
来源文件: <zipPath>
包含文件: <list main files>

请选择安装方式:
1. 用户级 (~/.mycc-store/skills/) — 所有项目可用
2. 项目级 (.mycc/skills/) — 仅当前项目
3. 临时使用 — 仅本次会话,不永久安装
4. 取消
```

For a multi-skill package, present all skills and ask whether to install
each one (or all to the same level).

**Name conflict detection (before asking):** For the user-chosen level,
check whether a skill with the same name already exists at the
destination:

```bash
# Windows PowerShell (example for project-level folder skill)
Test-Path ".mycc/skills/<skillName>"
# or for single-file:
Test-Path ".mycc/skills/<skillName>.md"

# Linux/macOS
test -e ".mycc/skills/<skillName>" && echo "conflict" || echo "ok"
```

If a conflict is detected, warn the user and ask whether to overwrite
before proceeding. If the user declines overwrite, suggest choosing a
different level or canceling.

**Wait for the user's explicit choice.** Do not assume a default.

### Step 7: Execute the installation

Based on the user's choice, read the corresponding action file and follow
its steps:

| Choice | Action file |
|--------|-------------|
| **User-level** (`~/.mycc-store/skills/`) | [Install on User Level](./install-skill-on-user-level.md) |
| **Project-level** (`.mycc/skills/`) | [Install on Project Level](./install-skill-on-project-level.md) |
| **Temporary (ad-hoc)** | [Run Ad-hoc](./run-skill-ad-hoc.md) |
| **Cancel** | Skip to Step 9 (cleanup) — do nothing |

Load the action file with `read_file`, then execute the steps it
describes. The action files contain the exact copy commands (per platform)
and the hookish-skill condition compilation step.

### Step 8: Verify the installation

After the action file's steps complete (for permanent installs only —
ad-hoc has no install to verify):

1. Call `skill_load(name="<skillName>")` to confirm the skill is loadable
   from its new location.
2. Optionally call `skill_search(search="<relevant keyword>")` to confirm
   the skill is discoverable via semantic search.
3. Report the result to the user via `brief`, including the final
   installed path.

If `skill_load` fails, report the error and investigate (wrong path, copy
failed, frontmatter issue). Do not skip this step — a silent failed
install is worse than no install.

### Step 9: Clean up the temp directory

**Always** delete the temp directory, whether the install succeeded,
failed, or was canceled. A leftover temp directory leaks disk space and
may confuse future extractions.

```bash
# Windows PowerShell
Remove-Item -Recurse -Force "<tmpDir>"

# Linux/macOS
rm -rf "<tmpDir>"
```

For the **ad-hoc** choice, the skill content was read directly from the
temp directory. The guidance applied during the session, but the temp
directory is still cleaned up here — the skill is intentionally
non-persistent. Tell the user that the skill was used temporarily and will
not be available after cleanup.

## Reference: Installation Actions

The installation execution is split into per-destination action files.
Load the relevant one with `read_file` in Step 7:

- [Install on User Level](./install-skill-on-user-level.md) — Install to
  `~/.mycc-store/skills/` (available in all projects)
- [Install on Project Level](./install-skill-on-project-level.md) —
  Install to `.mycc/skills/` (current project only)
- [Run Ad-hoc](./run-skill-ad-hoc.md) — Temporary one-session use, no
  persistent install

## Common Pitfalls

### Pitfall 1: Archive is not a skill package

**Problem:** After extraction, no `.md` file with valid frontmatter
(`name:` field) is found. The archive may contain a tool, documentation,
or unrelated data.

**Solution:** Report to the user exactly what was found (file types,
structure) and stop. Do not attempt to install non-skill content as a
skill. Clean up the temp directory.

### Pitfall 2: Name conflict at destination

**Problem:** A skill with the same name already exists at the chosen
destination level.

**Solution:** Detect the conflict BEFORE asking for consent (check the
destination path). Warn the user and ask whether to overwrite. If the
user declines, suggest a different level or cancel. Never silently
overwrite an existing skill.

### Pitfall 3: Temp directory left behind

**Problem:** The temp extraction directory is not cleaned up after the
process, leaking disk space.

**Solution:** Step 9 (cleanup) is mandatory and runs in ALL outcomes —
success, failure, and cancel. Use a `finally`-style discipline: even if
an earlier step errored, still run the cleanup command before finishing.

### Pitfall 4: Windows file encoding (mojibake)

**Problem:** On Windows, using `Get-Content` to read a skill `.md` file
with non-ASCII characters (CJK, emoji) produces mojibake because
PowerShell 5.1 defaults to the system ANSI codepage, not UTF-8.

**Solution:** Always use the **`read_file` tool** to read extracted
`.md` files — it handles UTF-8 (including BOM) automatically. Avoid
`Get-Content` for any file that may contain non-ASCII content.

### Pitfall 5: Hookish skill without compiled condition

**Problem:** A skill with a `when:` field is installed, but its hook
condition is never compiled. The hook never fires, so the skill appears
"installed but inactive."

**Solution:** After copying the skill files, check the frontmatter for a
`when:` field. If present, call `skill_compile(name="<skillName>")` to
compile the trigger condition into the hook system. The action files
include this step — do not skip it.

### Pitfall 6: Assuming a single skill in the archive

**Problem:** The archive contains multiple skills (multi-skill package),
but only the first detected one is installed.

**Solution:** In Step 4, detect ALL valid entrypoints. In Step 6, present
all of them and ask the user about each (or offer "install all to the
same level"). Do not silently drop skills.

## Verification Checklist

- [ ] Zip file exists and is readable (Step 1)
- [ ] Temp directory created (Step 2)
- [ ] Extraction succeeded and temp dir is non-empty (Step 3)
- [ ] Skill structure detected with valid frontmatter `name:` field (Step 4)
- [ ] Purpose summarized to user (Step 5)
- [ ] User consent and installation level obtained (Step 6)
- [ ] Name conflict checked (and overwrite confirmed if any) (Step 6)
- [ ] Correct action file loaded and its steps executed (Step 7)
- [ ] `skill_load` verification passed for permanent installs (Step 8)
- [ ] Hookish skill condition compiled via `skill_compile` if `when:` present (Step 7/action file)
- [ ] Temp directory cleaned up (Step 9)