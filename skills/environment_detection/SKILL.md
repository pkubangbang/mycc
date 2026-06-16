---
name: environment-detection
description: >
  Use to understand the "shape" of the current working directory (cwd).
  Answers five detection questions: Is this a well-known system folder
  (home, temp, /etc, /usr, C:\Windows)? Does cwd contain a git repo
  (with remote and branch info)? If not git, what is this directory
  (project, collection of repos, staging area, empty folder)? What
  executables are available (ripgrep, fd, fzf, jq, yq, ffmpeg, python,
  node, go, rustc)? And what is the user's likely intention (create new
  project, work on existing, manage multiple, be cautious in system dir)?
  Each step includes bash and PowerShell commands for cross-platform
  detection. Reports findings via brief() with a confidence level (0-10).
  Use when starting work in a new directory, encountering an unusual
  project layout, needing to understand available tools, or when unsure
  about the user's intentions for the current directory. Also covers
  common pitfalls: assuming project structure without checking, ignoring
  system folder constraints, and missing available tool detection.
keywords: [environment, detection, directory, project, git, executables, tools, cwd, working-directory, layout, exploration, workspace, setup, context, system, discover, analyze, assess]
---

# Environment Detection

This skill guides you through understanding the current working directory (cwd).

## Purpose

Use this skill when:
- Starting work in a new directory
- Encountering an unusual project layout
- Need to understand available tools
- Unsure about user intentions

## Detection Questions

Answer these questions using `bash` commands and `brief()` to report findings:

### 1. Is cwd a well-known system folder?

Check for common system locations:

```bash
# Compare cwd to known paths
pwd
echo $HOME
echo $USER
```

**Well-known folders:**
- User home: `/home/{user}` (Linux), `/Users/{user}` (macOS), `C:\Users\{user}` (Windows)
- System paths: `/usr`, `/bin`, `/etc`, `/var` (Linux/macOS), `C:\Windows`, `C:\Program Files` (Windows)
- Temp paths: `/tmp`, `/var/tmp` (Linux/macOS), `%TEMP%` (Windows)

**Use `brief()` to report:** Is this a system folder? Which one?

### 2. Does cwd contain a git repo?

```bash
# Check for git repo (Linux/macOS)
git rev-parse --is-inside-work-tree 2>/dev/null && echo "Git repo found" || echo "Not a git repo"

# On Windows PowerShell:
# git rev-parse --is-inside-work-tree 2>$null; if ($?) { "Git repo found" } else { "Not a git repo" }

# If git repo, get more info
git remote -v 2>/dev/null   # Use 2>$null on Windows PowerShell
git branch --show-current 2>/dev/null
```

**If git repo exists:**
- This is likely a **project directory**
- Note the remote URL (if any)
- Note the current branch

**Use `brief()` to report:** Git repo status and branch info.

### 3. If not a git repo, what is this directory?

```bash
# List directory contents (Linux/macOS)
ls -la

# On Windows PowerShell: Get-ChildItem -Force

# Check for project indicators (Linux/macOS)
ls -la package.json pyproject.toml Cargo.toml go.mod pom.xml requirements.txt 2>/dev/null

# On Windows PowerShell: Get-ChildItem package.json, pyproject.toml, ... -ErrorAction SilentlyContinue

# Check for collection of repos (Linux/macOS)
ls -d */ 2>/dev/null | head -20

# On Windows PowerShell: Get-ChildItem -Directory | Select-Object -First 20

# Count files and directories (Linux/macOS)
find . -maxdepth 1 -type f | wc -l
find . -maxdepth 1 -type d | wc -l

# On Windows PowerShell:
# (Get-ChildItem -File).Count
# (Get-ChildItem -Directory).Count
```

**Possible scenarios:**
- **Project (no git)**: Has project files but no `.git` folder
- **Collection of repos**: Multiple subdirectories, some with `.git`
- **Materials/staging**: Mixed files, no clear project structure
- **Empty folder**: Few or no files

**Use `brief()` to report:** Directory classification and reasoning.

### 4. What executables are available?

```bash
# Check for common development tools (Linux/macOS)
which ripgrep rg 2>/dev/null && echo "ripgrep available"
which fd fdfind 2>/dev/null && echo "fd available"
which fzf 2>/dev/null && echo "fzf available"
which jq yq 2>/dev/null && echo "JSON/YAML processors available"
which ffmpeg 2>/dev/null && echo "ffmpeg available"
which python python3 2>/dev/null && echo "Python available"
which node npm pnpm 2>/dev/null && echo "Node.js available"

# On Windows PowerShell, use Get-Command:
# Get-Command rg -ErrorAction SilentlyContinue
# Get-Command python -ErrorAction SilentlyContinue
# Get-Command node -ErrorAction SilentlyContinue
```

**Common tools to check:**
- Search: `ripgrep`/`rg`, `grep`
- File finding: `fd`, `find`
- JSON/YAML: `jq`, `yq`
- Media: `ffmpeg`
- Languages: `python`, `node`, `go`, `rustc`

**Use `brief()` to report:** List of available tools.

### 5. What is the user's likely intention?

Based on findings, infer user intent:

| Finding | Likely Intention |
|---------|------------------|
| Empty folder | Create new project |
| Git repo | Work on existing project |
| Collection of repos | Manage multiple projects |
| Project files, no git | Initialize git or work locally |
| System folder | Be cautious, ask user |

**Use `brief()` to report:** Inferred intention and confidence level.

## Process

### Step 1: Check System Folder

```bash
# Linux/macOS
pwd
echo "Home: $HOME"

# On Windows PowerShell:
# pwd
# echo "Home: $HOME"  # or $env:USERPROFILE
```

Report via `brief()`: Is this a system folder?

### Step 2: Check Git Status

```bash
# Linux/macOS
git rev-parse --is-inside-work-tree 2>/dev/null

# On Windows PowerShell:
# git rev-parse --is-inside-work-tree 2>$null
```

Report via `brief()`: Git repo status.

### Step 3: Inspect Directory Contents

```bash
# Linux/macOS
ls -la
find . -maxdepth 1 -type f | wc -l
find . -maxdepth 1 -type d | wc -l

# On Windows PowerShell:
# Get-ChildItem -Force
# (Get-ChildItem -File).Count
# (Get-ChildItem -Directory).Count
```

Report via `brief()`: Directory classification.

### Step 4: Check Available Tools

```bash
# Linux/macOS
which rg jq yq ffmpeg python node

# On Windows PowerShell:
# Get-Command rg, jq, yq, ffmpeg, python, node -ErrorAction SilentlyContinue
```

Report via `brief()`: Available executables.

### Step 5: Infer User Intention

Based on all findings, use `brief()` to report:
- Directory type (project, collection, empty, system)
- Available tools
- Inferred user intention
- Confidence level (0-10)

## Example Usage

```
User: "Help me with this project"

Agent: (loads environment-detection skill)

Agent: [runs pwd]
Agent: [runs git rev-parse --is-inside-work-tree]
Agent: [runs ls -la]

Agent uses brief():
- message: "Directory '/home/user/my-app' is a git repo (branch: main).
            Node.js project detected (package.json).
            Tools: ripgrep, jq, node available.
            Likely intention: Work on existing Node.js project."
- confidence: 9
```

## Common Pitfalls

### Pitfall 1: Assuming Project Structure

**Problem:** Assume a directory is a project without checking.

**Solution:** Always verify with `ls -la` and check for project files.

### Pitfall 2: Ignoring System Folders

**Problem:** Making changes in system folders like `/etc` or `/usr`.

**Solution:** Detect system folders and ask user for confirmation before proceeding.

### Pitfall 3: Missing Available Tools

**Problem:** Using tools that aren't available on the system.

**Solution:** Check with `which` before using specialized tools like `ripgrep` or `yq`.

## Verification Checklist

- [ ] Identified if cwd is a system folder
- [ ] Checked git repo status
- [ ] Classified directory type (project, collection, empty)
- [ ] Listed available executables
- [ ] Inferred user intention
- [ ] Reported findings via `brief()` with confidence level