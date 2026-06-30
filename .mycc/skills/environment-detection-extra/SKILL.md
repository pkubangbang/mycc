---
name: environment-detection-extra
description: >
  Extends the environment-detection skill for the mycc project itself.
  Adds knowledge about the built-in tool/skill layer (System layer) that
  is only relevant when working on the mycc codebase. The built-in layer
  stores tools in src/tools/ and skills in skills/ (package root), has
  highest priority (cannot be shadowed), and is the target for migrating
  approved prototypes from .mycc/. Use this skill together with
  environment-detection for a complete picture of all three layers.
  Only relevant when the project IS mycc itself.
keywords: [mycc, built-in, system layer, tool layer, skill layer, environment, detection, extension, project, priority]
---

# Environment Detection Extra (mycc-specific)

This skill extends the **`environment-detection`** skill with knowledge about
the **built-in (System) layer** — only relevant when working on the mycc
codebase itself.

## The Three-Layer System

When the project is **mycc itself**, tools and skills exist at three layers:

### Tool Layers

| Layer | Path | Scope | Priority |
|-------|------|-------|----------|
| **Built-in (System)** | `src/tools/` | All projects (shipped with mycc) | Highest (cannot be shadowed) |
| **Project** | `.mycc/tools/` | Current project only | Medium |
| **User** | `~/.mycc-store/tools/` | All projects for current user | Lowest |

### Skill Layers

| Layer | Path | Scope | Priority |
|-------|------|-------|----------|
| **Built-in (System)** | `skills/` (package root) | All projects (shipped with mycc) | Highest (cannot be shadowed) |
| **Project** | `.mycc/skills/` | Current project only | Medium |
| **User** | `~/.mycc-store/skills/` | All projects for current user | Lowest |

### Development Workflow

1. **Prototype** in `.mycc/tools/` or `.mycc/skills/` (project-level, hot-reloadable)
2. **Test** manually and iterate based on feedback
3. **Migrate** to `src/tools/` or `skills/` (built-in) when approved — this makes the tool/skill available to all projects

### Detection Commands

```bash
# List built-in tools
ls src/tools/ 2>/dev/null

# List built-in skills
ls skills/ 2>/dev/null

# List project-level tools
ls .mycc/tools/ 2>/dev/null

# List project-level skills
ls .mycc/skills/ 2>/dev/null

# Check user-level tools
ls ~/.mycc-store/tools/ 2>/dev/null

# Check user-level skills
ls ~/.mycc-store/skills/ 2>/dev/null
```

On Windows PowerShell:
```powershell
# List built-in tools
Get-ChildItem src/tools -ErrorAction SilentlyContinue

# List built-in skills
Get-ChildItem skills -ErrorAction SilentlyContinue

# List project-level tools
Get-ChildItem .mycc/tools -ErrorAction SilentlyContinue

# List project-level skills
Get-ChildItem .mycc/skills -ErrorAction SilentlyContinue

# Check user-level tools
Get-ChildItem "$env:USERPROFILE/.mycc-store/tools" -ErrorAction SilentlyContinue

# Check user-level skills
Get-ChildItem "$env:USERPROFILE/.mycc-store/skills" -ErrorAction SilentlyContinue
```

## Related Skills

- **`environment-detection`** — Base skill for understanding the current working directory, detecting project/user tool/skill layers, and available executables. Load this first for general environment detection.
- **`tool-and-skill-development`** — Covers the two-phase workflow (prototype in `.mycc/` → migrate to built-in) for developing new tools and skills.
- **`create-skill`** — Guides creating new skills with templates and quality checklist.
- **`add-tool`** — Guides creating new tools with templates and parameter validation.
