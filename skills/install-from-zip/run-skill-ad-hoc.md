# Run Skill Ad-hoc (Temporary)

This action file covers **temporary one-session use** of a detected skill
without persistently installing it. The skill content is read directly
from the temp extraction directory and applied to guide the current
session's work. After the session, the temp directory is cleaned up and
the skill is no longer available.

Use this option when the user wants to try a skill before committing to a
permanent install, or only needs it for the current task.

## Prerequisites

Before following these steps, the main `install-from-zip` SKILL.md process
should have already:
- Extracted the zip to a temp directory (Step 3)
- Detected the skill structure and confirmed valid frontmatter (Step 4)
- Obtained user consent for temporary (ad-hoc) use (Step 6)

You need the **temp directory path** and the **detected skill name**.

## What Ad-hoc Means

- **No files are copied** to `~/.mycc-store/skills/` or `.mycc/skills/`.
- The skill is **not registered** with the loader — `skill_load` and
  `skill_search` will NOT find it.
- Hookish skills (`when:` field) **cannot trigger** — hooks only fire for
  skills registered in a skill directory. Ad-hoc skills are read-only
  guidance for this session.
- The skill content is read via `read_file` and followed manually by the
  agent for the duration of the session.
- After cleanup (Step 9 of the main process), the skill is gone.

## Step 1: Locate the skill entrypoint in the temp directory

The detection step (Step 4 of the main process) identified the skill's
entrypoint file. It is either:

- A single `.md` file directly under the temp root, or
- A `SKILL.md` file inside a subdirectory under the temp root

Use the path recorded during detection.

## Step 2: Read the skill content

Use the **`read_file` tool** to read the skill entrypoint file from the
temp directory:

```
read_file(path="<tmpDir>/<skillName>.md")
# or for a folder skill:
read_file(path="<tmpDir>/<skillName>/SKILL.md")
```

**Use `read_file`, not `Get-Content` or `cat`** — `read_file` handles
UTF-8 encoding (including BOM) correctly on all platforms, avoiding the
Windows mojibake trap.

## Step 3: Apply the skill guidance

The skill content is now in your context. Follow its guidance for the
current session's work, just as you would if you had loaded it via
`skill_load`. The skill's process steps, reference tables, pitfalls, and
checklists are all available to you.

If the skill references sibling files (e.g., a folder skill with
`[Link](./cheatsheet.md)` references), read those with `read_file` using
absolute paths derived from the temp directory:

```
read_file(path="<tmpDir>/<skillName>/cheatsheet.md")
```

## Step 4: Note the limitation to the user

Inform the user that this is a temporary use:

> The skill "<skillName>" has been loaded temporarily for this session.
> It will not be available after this session ends. To make it permanent,
> re-run the install and choose user-level or project-level installation.

## Step 5: Return to main process

There is no installation to verify (Step 8 is skipped for ad-hoc — there
is nothing to `skill_load`). Return to the main process for Step 9
(cleanup), which deletes the temp directory.

**Important:** Once cleanup runs, the skill content is no longer on disk.
If you need to reference it again later in the session, re-read it from
the temp directory BEFORE cleanup, or the user should choose a permanent
install instead.