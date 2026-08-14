# install-from-zip — Design Document

> **Audience:** mycc developers. This document records the architecture
> vision and future extension directions for the `install-from-zip` skill.
> It is NOT loaded by the agent at runtime — the skill content itself
> (`skills/install-from-zip/SKILL.md` + action files) focuses only on the
> currently implemented scope.

## Vision

`install-from-zip` is designed as a **general package installer** for
mycc, not merely a skill installer. A "package" is a `.zip` archive whose
contents conform to a recognized mycc extension format. The skill detects
the package type from the archive's structure, summarizes its purpose,
asks the user for consent and a destination, then dispatches to a
type-and-destination-specific action file that performs the install.

The current implementation handles only the **skill** package type. The
architecture is extensible: new package types can be added by defining
their detection rules in `SKILL.md` and adding corresponding action
files, without restructuring the existing flow.

## Current Scope: Skill Packages

### Detection

A zip is recognized as a skill package if, after extraction, it contains:

- One or more `.md` files at the archive root with YAML frontmatter
  containing a `name:` field (single-file skills), **or**
- One or more subdirectories each containing a `SKILL.md` with frontmatter
  containing a `name:` field (folder skills), **or**
- A mix of the above (multi-skill package).

### Destinations

| Destination | Path | Scope | Action file |
|-------------|------|-------|-------------|
| User-level | `~/.mycc-store/skills/` | All projects | `install-skill-on-user-level.md` |
| Project-level | `.mycc/skills/` | Current project | `install-skill-on-project-level.md` |
| Ad-hoc (temporary) | (none — read from temp) | Current session | `run-skill-ad-hoc.md` |

### File Structure

```
skills/install-from-zip/
├── SKILL.md                          # Main entry: extract → detect → summarize → consent → dispatch → verify → cleanup
├── install-skill-on-user-level.md    # Skill → user-level install actions
├── install-skill-on-project-level.md # Skill → project-level install actions
└── run-skill-ad-hoc.md               # Skill → temporary one-session use
```

## Future Extension Directions

The following package types are envisioned but **not yet implemented**.
They are documented here so the extension path is clear when the need
arises. Implementing a new type requires:

1. Adding its detection rule to the detection step in `SKILL.md`.
2. Adding destination-specific action files (following the naming
   convention `<verb>-<type>-on-<destination>.md` or similar).
3. Updating the consent/options presentation to include the new type's
   valid destinations.

### Tool Packages

A zip containing `.ts`/`.js` files that export a `ToolDefinition` object.

- **Detection:** Archive root contains `.ts`/`.js` files; reading the
  file reveals an exported object matching the `ToolDefinition` shape
  (`name`, `description`, `input_schema`, `scope`, `handler`).
- **Destinations:**
  - User-level: `~/.mycc-store/tools/`
  - Project-level: `.mycc/tools/`
  - Ad-hoc: not applicable (tools must be loaded by the loader to be
    callable; there is no "temporary tool" concept without registration).
- **Action files (future):** `install-tool-on-user-level.md`,
  `install-tool-on-project-level.md`.
- **Post-install:** Tools are auto-loaded by the loader's hot-reload
  watcher; no compile step needed (unlike hookish skills).

### Patch Packages

A zip containing a patch that hotfixes or updates mycc's own code
temporarily (e.g., a bug fix not yet released).

- **Detection:** Archive contains a manifest file (e.g., `PATCH.md` or
  `patch-manifest.json`) describing the patch, plus the patched source
  files in their target-relative paths.
- **Destinations:** Patches apply to the mycc package source tree
  (`src/`), not to a skill/tool directory. The "destination" concept
  differs — it is more about applying vs. reverting.
- **Action files (future):** `apply-patch.md`, `revert-patch.md`.
- **Concerns:** Patches modify the running codebase; version
  compatibility checks and revert safety are critical. Likely paired with
  the `mycc-online-hotfix` skill's live-test workflow.

### OOBE / Action Packages

A zip containing a one-time action to execute on first run or on demand
(e.g., pre-filling the "pitfall" wiki domain with initial entries, or
introducing a feature request / new domain into the knowledge base).

- **Detection:** Archive contains an action manifest (e.g., `OOBE.md` or
  `action-manifest.json`) describing the one-time action and any data
  files (wiki entries, domain registrations, etc.).
- **Destinations:** OOBE actions are typically one-shot — they execute
  their effect (e.g., `wiki_put` entries, `/domain add`) and do not
  persist as installed skills/tools.
- **Action files (future):** `run-oobe-action.md`.
- **Concerns:** OOBE actions may modify persistent state (wiki, domains);
  idempotency and the marker-file pattern (check a marker before
  re-running) apply.

### Info / Knowledge Packages

A zip containing documentation or knowledge entries to import into the
wiki/knowledge base, but not a runnable skill or tool.

- **Detection:** Archive contains `.md`/structured files without skill
  frontmatter (`name:` field absent), possibly with a manifest mapping
  files to wiki domains.
- **Destinations:** Imported into the wiki via `wiki_prepare`/`wiki_put`
  to specified domains. Not installed into a skill directory.
- **Action files (future):** `import-info-to-wiki.md`.

## Design Principles

1. **Skill content stays problem-focused.** The `SKILL.md` and action
   files document only the currently implemented scope (skill packages).
   Future extension directions live in this design doc, not in the skill
   content — per the pitfall "Skills should solve the problem, not
   explain meta-logic about file access."
2. **Per-destination action files.** Installation logic is split by
   destination so each can be extended or modified independently (e.g.,
   adding conflict-resolution policies specific to one level).
3. **Consent is mandatory.** No package is installed without explicit
   user consent and a chosen destination. The agent never silently
   installs or overwrites.
4. **Cleanup is unconditional.** The temp extraction directory is always
   removed, in all outcomes (success, failure, cancel).
5. **Cross-platform by default.** All commands have Windows (PowerShell)
   and Linux/macOS (bash) variants. The skill does not depend on npm zip
   libraries — it uses OS-native extraction (`Expand-Archive` / `unzip` /
   `tar`).