# Mindmap Module Redesign

> **Status**: Implemented. This plan shipped in full — both the compile+patch-rebuild flow (Part 1) and the recap→patch concurrent forkChat flow (Part 2). The sections below describe the shipped design. File paths and function names reference the actual implementation in `src/mindmap/`.

## Overview

Two independent on-disk lines that merge only in memory at load time:

1. **mindmap.json** — compiled from MYCC.md (foreground, synchronous). Contains MYCC.md-sourced nodes with summaries. Never modified by patches.
2. **mindmap-patch.jsonl** — append-only log of patch actions from recap. Independent line.

At runtime: load mindmap.json → replay patches → in-memory merged model. `recall` uses the merged model.

### Key properties
- **mindmap.json is a superset of MYCC.md** structurally (patches add nodes), but on disk the superset is split: mindmap.json has the MYCC.md base, patches have the additions/modifications.
- **Patch and mindmap never mix on disk** — only in memory.
- **Compile is foreground** (same as current behavior) — no background/async.
- **Hash check at startup only** — same as existing logic, no file watch.
- **Patches update both in-memory and jsonl simultaneously** — append on every patch action.

---

## Core Concept: Two Independent Lines

### Line 1: mindmap.json (MYCC.md-sourced)
- Compiled from MYCC.md via `compile_mindmap()` (foreground, as now)
- All nodes are MYCC.md-sourced (in memory: `is_mycc = true`)
- Nodes have `text` (from MYCC.md) and `summary` (LLM-generated via A-N-C-E)
- Never touched by patches — patches don't write to mindmap.json

### Line 2: mindmap-patch.jsonl (agent-discovered knowledge)
- Append-only JSONL file at `.mycc/mindmap-patch.jsonl`
- Each line is one patch action: `add` / `update` / `delete`
- Recorded during recap (one action per recap, via forkChat)
- Can reference any node in mindmap.json (by path) — add children to existing nodes, update existing node text, delete existing nodes

### Runtime Merge (in-memory only)
At startup (and when reloading):
1. Load mindmap.json → base tree (in memory: all `is_mycc = true`)
2. Read mindmap-patch.jsonl → list of actions
3. Replay actions in order → apply to in-memory tree
4. Result: merged tree with both MYCC.md nodes and patch-added nodes
5. `recall` reads this merged in-memory tree

### In-Memory Flags: `is_mycc` and `is_patch`

Two flags exist **only in memory**, never serialized to mindmap.json:

```typescript
interface Node {
  // ... existing fields (as in mindmap.json) ...
  /** IN-MEMORY ONLY: true if node originates from mindmap.json (= MYCC.md) */
  is_mycc: boolean;
  /** IN-MEMORY ONLY: true if node was created or modified by a patch */
  is_patch: boolean;
}
```

**`is_mycc`** — set to `true` for all nodes loaded from mindmap.json. Since mindmap.json is an isomorphism of MYCC.md, every node in it is by definition MYCC.md-sourced. No need to store this in the JSON file itself — it's implied by "came from mindmap.json". Patch-added nodes get `is_mycc = false`.

**`is_patch`** — set to `true` when a patch touches a node:
- `add` patch → new node created: `is_mycc = false, is_patch = true`
- `update` patch → existing node modified: `is_patch = true` (preserves the `is_mycc` value — an `is_mycc` node that's been patched is still `is_mycc = true` but now also `is_patch = true`)
- `delete` patch → node removed from tree (no flags needed)

**Why `is_patch` matters during recompile:**
When `/mindmap compile` recompiles MYCC.md, it regenerates mindmap.json with fresh text from MYCC.md. An `is_mycc` node whose text was modified by an `update` patch would have its text **overwritten** back to the MYCC.md original. The `is_patch` flag tells the rebuild step: "this node was modified by a patch — preserve the patched text by emitting an `update` action in the rebuilt jsonl."

Without `is_patch`, recompile would silently discard patch modifications to MYCC.md-sourced nodes. With `is_patch`, the rebuild preserves them.

**Summary generation**: only `is_mycc: true` nodes get summaries during compile. `is_mycc: false` (patch-added) nodes have `summary: ''`. When an `update` patch modifies an `is_mycc` node, its `summary` is cleared — the next compile will regenerate it from the patched text (if the patch is baked into mindmap.json via rebuild) or it stays empty (if the patch is replayed from jsonl at load time).

**Flag derivation at load time:**
```
Load mindmap.json → all nodes: is_mycc = true, is_patch = false
Replay patches:
  add → new node: is_mycc = false, is_patch = true
  update → target node: is_patch = true (is_mycc unchanged)
  delete → node removed
```

---

## Part 1: Compile (Foreground) + Patch Rebuild

### 1.1 Compile (unchanged core, two additions)

`compile_mindmap()` stays as a foreground synchronous operation (as it is now). Two additions:

#### Addition 1: In-memory flags (`is_mycc`, `is_patch`)
These flags are NOT in mindmap.json. They are set at load time:
- `load_mindmap` sets `is_mycc = true, is_patch = false` on every node loaded from mindmap.json
- Patch replay sets flags per action (see "Flag derivation at load time" above)
No change to `build_node()` or `compile-utils.ts` — the JSON file doesn't contain these flags.

#### Addition 2: Patch rebuild (new step after compile)

After compiling mindmap.json, the compile action performs a **patch rebuild**:

1. Take the current **in-memory** merged tree (mindmap.json + patches applied)
2. Traverse it **breadth-first** (BFS)
3. For each `is_mycc: false` node (patch-added), emit a clean `add` action
4. For each `is_mycc: true, is_patch: true` node (MYCC.md node modified by patch), emit a clean `update` action with the patched text
5. For each `is_mycc: true` node that is **absent from the fresh base** (deleted from MYCC.md), emit a clean `add` action to **preserve** the content as patch-added knowledge
6. Write the new actions to mindmap-patch.jsonl, **replacing** the old file

**Purpose of patch rebuild**: eliminate duplicate/stale patches. Over time, the jsonl accumulates:
- Multiple `update` patches to the same node (only the latest matters)
- `add` patches for nodes that were later `delete`d (cancel out)
- `update` patches to nodes that no longer exist (stale after MYCC.md restructure)

BFS traversal of the in-memory tree produces a **minimal, consistent** patch set:
- One `add` per surviving patch-added node
- One `update` per surviving text modification
- One `add` per MYCC.md-deleted node (preserved as patch-added knowledge, not discarded)

### 1.2 Patch Rebuild Algorithm (Detailed)

The rebuild traverses the in-memory merged tree (BFS) and uses the `is_mycc` / `is_patch` flags to decide what actions to emit:

| Node state | `is_mycc` | `is_patch` | Rebuild action |
|-----------|-----------|------------|----------------|
| Pure MYCC.md node, unmodified | true | false | None — already in fresh mindmap.json |
| MYCC.md node, modified by patch | true | true (update) | `update` with current (patched) text |
| Patch-added node | false | true (add) | `add` with parent path, title, text |
| MYCC.md-deleted node (is_mycc, absent from fresh base) | true | false | `add` — PRESERVED as patch-added knowledge (is_mycc=false on replay) |

```typescript
function rebuildPatches(
  mergedTree: Node,       // in-memory merged tree (mindmap + patches applied)
  baseTree: Node,         // freshly compiled mindmap.json tree
  mindmapHash: string,    // hash of the freshly compiled mindmap.json
): MindmapPatchAction[] {
  const actions: MindmapPatchAction[] = [];
  const queue: Node[] = [mergedTree];
  const basePaths = collectPaths(baseTree);  // paths present in fresh compile
  
  // BFS traversal of the merged tree
  while (queue.length > 0) {
    const node = queue.shift()!;
    queue.push(...node.children);
    
    if (!node.is_mycc) {
      // Patch-added node → emit 'add' action
      const parentPath = node.id.split('/').slice(0, -1).join('/') || '/';
      actions.push({ action: 'add', path: parentPath, title: node.title, text: node.text,
        timestamp: new Date().toISOString(), checkpoint_id: '',
        reason: 'Rebuilt from in-memory state', mindmap_hash: mindmapHash });
    } else if (!basePaths.has(node.id) && node.id !== '/' && node.id !== '') {
      // MYCC.md-deleted node (is_mycc, absent from fresh base) → PRESERVE as 'add'
      // On replay it becomes is_mycc=false, so the content survives.
      const parentPath = node.id.split('/').slice(0, -1).join('/') || '/';
      actions.push({ action: 'add', path: parentPath, title: node.title, text: node.text,
        timestamp: new Date().toISOString(), checkpoint_id: '',
        reason: 'Preserved from MYCC.md deletion', mindmap_hash: mindmapHash });
    } else if (node.is_patch) {
      // MYCC.md node modified by patch → emit 'update' to preserve patched text
      actions.push({ action: 'update', path: node.id, text: node.text,
        timestamp: new Date().toISOString(), checkpoint_id: '',
        reason: 'Rebuilt from in-memory state', mindmap_hash: mindmapHash });
    }
    // else: is_mycc=true, is_patch=false, in base → pure MYCC.md node, no action
  }
  
  return actions;
}
```

**Key insights**:
- The `is_patch` flag distinguishes "MYCC.md node that matches the fresh compile" (no action) from "MYCC.md node modified by a patch" (needs `update`).
- The `basePaths` check distinguishes "MYCC.md node still present" (no action or `update`) from "MYCC.md node deleted since last compile" (preserved as `add` — `is_mycc=false` on replay). This ensures MYCC.md deletions do not silently discard agent-known knowledge; the deleted content is converted to patch-added knowledge and survives.
- The BFS visits the entire deleted subtree, so deleted parent + children are all preserved as separate `add` actions.

### 1.3 Full Compile Flow

```
/mindmap compile (or startup hash-check triggers compile):
  1. compile_mindmap(MYCC.md) → new mindmap.json (foreground, synchronous)
     - All nodes get is_mycc=true, is_patch=false at load (in-memory flags)
  2. Load new mindmap.json → baseTree
  3. Load current in-memory merged tree (if any) → mergedTree
     - If no in-memory tree (fresh start): mergedTree = baseTree (no patches)
  4. rebuildPatches(mergedTree, baseTree) → clean action list
  5. Write clean actions to mindmap-patch.jsonl (replace old file)
  6. Reload: baseTree + replay clean patches → new in-memory tree
  7. ctx.core.setMindmap(new in-memory tree)
```

### 1.4 Startup Hash Check (unchanged logic)

At startup in `agent-repl.ts`, the existing hash-check logic is preserved:
- Load mindmap.json
- Compute hash of MYCC.md
- If hash matches → load + replay patches → set in-memory
- If hash mismatch → warn (existing behavior: "Validation failed, loading anyway")
  - User can run `/mindmap compile` to recompile

No file watch. No automatic compile. Same as current behavior.

### 1.5 Files (as shipped)

| File | Role |
|------|------|
| `src/mindmap/types.ts` | `is_mycc: boolean` and `is_patch: boolean` on `Node` (in-memory only, not serialized). `MindmapPatchAction` interface. |
| `src/mindmap/compile-utils.ts` | No change for flags — `is_mycc`/`is_patch` are set at load time. Provides `parse_markdown`, `build_node`, `extract_links`, lock management (4h freshness), `ProgressTracker`. |
| `src/mindmap/validate.ts` | No change — `is_mycc`/`is_patch` not in mindmap.json, validation unchanged. |
| `src/mindmap/compile.ts` | Rotation-based compile (`.new`/`.bak`), lock-based resumption, semaphore (max 3 concurrent). `/mindmap compile` calls `rebuildPatches()` and rewrites jsonl. |
| `src/slashes/mindmap.ts` | `/mindmap compile` does compile + patch rebuild; `/mindmap rebuild-patches` standalone. |
| `src/loop/agent-repl.ts` | Mindmap loading with patch replay. Keeps existing hash-check logic. |
| `src/mindmap/load.ts` | Sets `is_mycc = true, is_patch = false` on every node during `load_mindmap`. Strips flags before serialization. |

### 1.6 New File (shipped)

| File | Purpose |
|------|---------|
| `src/mindmap/patch-jsonl.ts` | `validatePatchAction()`, `appendPatch()`, `readAllPatches()`, `writePatches()` (full rewrite for rebuild), `rebuildPatches()`, `clearPatches()`, `getPatchPath()` |

---

## Part 2: Recap → Patch Flow (Two Concurrent forkChat Calls)

### 2.1 Design: Two Concurrent forkChat Calls

Each recap launches **two concurrent forkChat calls** (via `Promise.all`), both forking from the same triologue state:

1. **forkChat #1 — Recap Summary** (same as current `handleRecap`): reviews the checkpoint span and produces the structured recap summary.
2. **forkChat #2 — Patch Decision** (new): independently reviews the same checkpoint span and decides if one patch action is warranted. Does NOT receive the recap summary — it works directly from the conversation history, same as forkChat #1.

**Why concurrent works:**
- Both calls fork from the **same triologue messages** — the checkpoint span is the shared input.
- forkChat #1 compresses that span into a summary; forkChat #2 makes a structural decision from that span. Neither depends on the other's output.
- Both calls share the **same prompt-cache prefix** (system + projectContext + conversation + tools), so running them concurrently means both hit the cache simultaneously.
- Result: recap completes in **one round-trip latency** instead of two sequential.

**Why two calls instead of one**: mixing summary generation and patch decision in a single prompt makes the LLM's task ambiguous — it has to both summarize AND produce structured JSON. LLMs are unreliable at multi-task prompts with different output formats. Separating them:
- Each call has a single, clear objective → more stable responses
- Summary call is unchanged from current behavior (proven to work)
- Patch call has a focused prompt with only one output format (JSON or "none")
- Easier to validate and retry independently

### 2.2 forkChat #1 — Recap Summary (unchanged)

This is exactly the existing `handleRecap` logic — `buildRecapPrompt` + `forkChat` with `toolChoice: 'none'`. Produces the structured summary note. No changes to the prompt or logic.

### 2.3 forkChat #2 — Patch Decision

forkChat #2 runs concurrently with #1, forking from the same triologue messages. It does NOT receive the recap summary. Its prompt:

```
[MINDMAP PATCH] You just completed a checkpoint: "{description}".
Review the conversation history from when the checkpoint was created up to now.

Here is the current mindmap tree (paths only, [M] = MYCC.md-sourced, [P] = patch-added):
{treeOutline}

Based on what was learned during this checkpoint, decide if ONE mindmap node should be changed.
You may choose ONE of:
- ADD: add a child node to an existing parent (provide path=parent_path, title, text)
- UPDATE: update an existing node's text (provide path=target_path, text)
- DELETE: delete an existing non-root node (provide path=target_path)

Rules:
- For ADD: path MUST be an existing node (the parent)
- For UPDATE/DELETE: path MUST be an existing node (the target), not root
- Only make a change if genuinely warranted by new discoveries
- Be conservative — the mindmap is shared knowledge

If no change is warranted, respond exactly: none

Otherwise, respond with ONE JSON object (no other text):
{"action":"add|update|delete","path":"/...","title":"...","text":"...","reason":"..."}

Output TEXT ONLY — do NOT use any tools.
```

### 2.4 Response Parsing & Validation (forkChat #2 only)

```typescript
interface ParsedPatchResponse {
  patch: MindmapPatchAction | null;   // parsed action, or null if "none"
  error?: string;                     // validation error (for retry feedback)
}

function parsePatchResponse(response: string, mindmap: Mindmap, checkpointId: string): ParsedPatchResponse {
  const trimmed = response.trim();
  
  // 1. "none" case
  if (trimmed.toLowerCase() === 'none' || trimmed === '') {
    return { patch: null };
  }
  
  // 2. Parse JSON
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { patch: null, error: `Response is not valid JSON: "${trimmed.slice(0, 100)}"` };
  }
  
  // 3. Validate action type
  if (!['add', 'update', 'delete'].includes(parsed.action)) {
    return { patch: null, error: `Invalid action "${parsed.action}". Must be add, update, or delete.` };
  }
  
  // 4. Validate path
  if (!parsed.path || typeof parsed.path !== 'string') {
    return { patch: null, error: 'Missing or invalid "path" field.' };
  }
  
  const targetNode = get_node(mindmap, parsed.path);
  if (parsed.action === 'add') {
    if (!targetNode) {
      return { patch: null, error: `Parent node not found: "${parsed.path}"` };
    }
    if (!parsed.title || typeof parsed.title !== 'string') {
      return { patch: null, error: 'ADD requires a "title" field.' };
    }
    if (!parsed.text || typeof parsed.text !== 'string') {
      return { patch: null, error: 'ADD requires a "text" field.' };
    }
  } else {
    if (!targetNode) {
      return { patch: null, error: `Target node not found: "${parsed.path}"` };
    }
    if (parsed.path === '/' || parsed.path === '') {
      return { patch: null, error: 'Cannot update or delete root node.' };
    }
    if (parsed.action === 'update' && (!parsed.text || typeof parsed.text !== 'string')) {
      return { patch: null, error: 'UPDATE requires a "text" field.' };
    }
  }
  
  // 5. Build validated patch action
  return {
    patch: {
      action: parsed.action,
      path: parsed.path,
      title: parsed.title,
      text: parsed.text,
      timestamp: new Date().toISOString(),
      checkpoint_id: checkpointId,
      reason: parsed.reason || '',
      mindmap_hash: mindmap.hash,
    },
  };
}
```

### 2.5 Retry Logic (forkChat #2 only)

forkChat #2 has its own retry loop, independent of forkChat #1:

```typescript
async function generatePatchAction(
  fullMessages: Message[],
  allTools: Tool[],
  description: string,
  mindmap: Mindmap,
  checkpointId: string,
  escAware?: <T>(fn: (ac: AbortController) => Promise<T>, cleanup: () => T) => Promise<T>,
): Promise<MindmapPatchAction | null> {
  const MAX_RETRIES = 2;
  let feedback = '';
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const treeOutline = generateTreeOutline(mindmap.root);
    const prompt = buildPatchPrompt(description, treeOutline, feedback);
    
    let response: string;
    if (escAware) {
      const result = await escAware(
        async (ac) => forkChat(fullMessages, allTools, prompt, ac.signal, 'none'),
        () => null as string | null
      );
      if (result === null) return null;  // ESC pressed — skip patch
      response = result;
    } else {
      response = await forkChat(fullMessages, allTools, prompt, undefined, 'none');
    }
    
    const parsed = parsePatchResponse(response, mindmap, checkpointId);
    if (!parsed.error) {
      return parsed.patch;  // valid (including null = "none")
    }
    
    // Invalid — prepare feedback for retry
    feedback = `\n\n**Your previous response was invalid:**\n${parsed.error}\nPlease fix and respond again with either "none" or a valid JSON object.`;
  }
  
  // All retries exhausted — no patch
  return null;
}
```

### 2.6 Full Recap+Patch Flow (Concurrent)

```typescript
async function handleRecapWithPatch(
  fullMessages, allTools, description, mindmap, checkpointId,
  escAware?, comment?, lastUserQuery?, checkpointResult?
): Promise<{ summary: string; patch: MindmapPatchAction | null }> {
  // ── Launch both forkChats concurrently via Promise.all ──
  // Both fork from the same triologue messages — neither depends on the other's output.
  const [summary, patch] = await Promise.all([
    // forkChat #1: Recap Summary (unchanged from current handleRecap)
    handleRecap(fullMessages, allTools, description, escAware, comment, lastUserQuery, checkpointResult),
    // forkChat #2: Patch Decision (independent, concurrent)
    mindmap
      ? generatePatchAction(fullMessages, allTools, description, mindmap, checkpointId, escAware)
      : Promise.resolve(null),
  ]);
  
  return { summary, patch };
}
```

**Key**: forkChat #1 and #2 run concurrently via `Promise.all`. Both fork from the same triologue state. #1 does summarization (proven prompt, stable). #2 does patch decision (focused prompt, easy to validate). Neither prompt mixes objectives. If ESC is pressed, both calls are aborted via their shared AbortSignal.

**Note on retries**: if forkChat #2's first response is invalid, the retry loop runs *after* `Promise.all` resolves — by that point forkChat #1 has already completed. This is acceptable because retries are rare (the patch prompt is simple) and the summary is already available for the triologue replacement.

### 2.5 Patch Action Type

```typescript
interface MindmapPatchAction {
  action: 'add' | 'update' | 'delete';
  path: string;           // parent for 'add', target for 'update'/'delete'
  title?: string;         // for 'add'
  text?: string;          // for 'add'/'update'
  timestamp: string;
  checkpoint_id: string;
  reason: string;
  mindmap_hash: string;   // hash of mindmap.json at time of patch
}
```

### 2.6 Patch Application + JSONL Write (simultaneous)

When a valid patch is produced by recap:

```typescript
// In handleRecapWithPatch caller (hook.ts / teammate-worker.ts):
if (patch) {
  const mindmap = ctx.core.getMindmap();
  if (mindmap) {
    // 1. Apply to in-memory tree
    applyPatchAction(mindmap, patch);
    
    // 2. Append to jsonl (simultaneous — same logical operation)
    const patchPath = getPatchPath(ctx.core.getWorkDir());
    appendPatch(patch, patchPath);
  }
}
```

**Both operations happen together**: the in-memory tree is updated AND the jsonl gets a new line. If the process crashes after one but before the other, the inconsistency is resolved at next startup (jsonl is the source of truth; in-memory is rebuilt from it).

### 2.7 applyPatchAction (pure in-memory, no LLM)

```typescript
function applyPatchAction(mindmap: Mindmap, action: MindmapPatchAction): boolean {
  switch (action.action) {
    case 'add': {
      const parent = get_node(mindmap, action.path);
      if (!parent) return false;
      const id = parent.id === '/' 
        ? `/${safeNodeId(action.title!)}` 
        : `${parent.id}/${safeNodeId(action.title!)}`;
      parent.children.push({
        id, title: action.title!, text: action.text!,
        summary: '', level: parent.level + 1,
        children: [], links: [],
        is_mycc: false,   // patch-added, not from MYCC.md
        is_patch: true,   // marked as patch-touched
      });
      return true;
    }
    case 'update': {
      const node = get_node(mindmap, action.path);
      if (!node) return false;
      node.text = action.text!;
      node.summary = '';  // clear (re-summarized on next compile if is_mycc)
      node.is_patch = true;  // mark as patch-modified
      // is_mycc is preserved — an is_mycc node that's patched is still is_mycc
      return true;
    }
    case 'delete': {
      if (action.path === '/' || action.path === '') return false;
      // ... find parent, remove child (same as existing remove_node logic)
      return true;
    }
  }
}
```

### 2.8 Tree Outline for Prompt

```typescript
function generateTreeOutline(node: Node, indent: string = ''): string {
  const marker = node.is_mycc ? '[M]' : '[P]';
  const lines = [`${indent}${marker} ${node.id}`];
  for (const child of node.children) {
    lines.push(generateTreeOutline(child, indent + '  '));
  }
  return lines.join('\n');
}
```

Truncate if tree is large (> 200 nodes): show first 3 levels + count of deeper nodes.

### 2.9 Files (as shipped)

| File | Role |
|------|------|
| `src/loop/checkpoint-recap.ts` | `handleRecap` (forkChat #1, unchanged). `generatePatchAction` (forkChat #2, independent, concurrent, with validation + retry). `handleRecapWithPatch` wrapper launching both via `Promise.all`. Returns patch to caller. |
| `src/mindmap/patch.ts` | `applyPatchAction()` (pure in-memory, no LLM). Also has `patch_mindmap()`, `summarize_node()`, `add_child_node()`, `remove_node()`, `move_node()`. |
| `src/mindmap/types.ts` | `MindmapPatchAction` interface |
| `src/loop/states/hook.ts` | Calls `handleRecapWithPatch`, applies patch (in-memory + jsonl simultaneously) |

---

## Part 3: Startup Load + Patch Replay

### 3.1 Startup Sequence (in agent-repl.ts)

Replace the current mindmap loading block:

```typescript
// 1. Load mindmap.json + replay patches
const mindmap = loadMindmapWithPatches(workDir);
let mindmapLoaded = false;

if (mindmap) {
  // 2. Hash-check (existing logic preserved)
  const claudeMdPath = path.join(workDir, 'MYCC.md');
  if (fs.existsSync(claudeMdPath) && !validate_mindmap(mindmap, claudeMdPath)) {
    console.log(chalk.yellow('[mindmap] Validation failed (outdated). Loading anyway.'));
  } else {
    console.log(chalk.gray(`[mindmap] Loaded: ${countNodes(mindmap.root)} nodes`));
  }
  ctx.core.setMindmap(mindmap);
  mindmapLoaded = true;
} else {
  console.log(chalk.yellow('[mindmap] No mindmap found. LLM will read MYCC.md directly.'));
}

// 3. Set instruction (existing logic)
if (mindmapLoaded) {
  triologue.setMindmapInstruction();
} else {
  triologue.setNoMindmapInstruction();
}
```

### 3.2 loadMindmapWithPatches

```typescript
function loadMindmapWithPatches(workDir: string): Mindmap | null {
  const mindmapPath = get_default_mindmap_path(workDir);
  if (!fs.existsSync(mindmapPath)) return null;
  
  let mindmap: Mindmap;
  try {
    mindmap = load_mindmap(mindmapPath);
  } catch (err) {
    console.log(chalk.red(`[mindmap] Failed to load: ${(err as Error).message}`));
    return null;
  }
  
  // Replay patches from jsonl
  const patchPath = getPatchPath(workDir);
  if (fs.existsSync(patchPath)) {
    const patches = readAllPatches(patchPath);
    let applied = 0;
    let skipped = 0;
    for (const patch of patches) {
      // Skip patches created against a different mindmap.json version
      if (patch.mindmap_hash !== mindmap.hash) {
        skipped++;
        continue;
      }
      if (applyPatchAction(mindmap, patch)) {
        applied++;
      } else {
        skipped++;
      }
    }
    if (applied > 0 || skipped > 0) {
      console.log(chalk.gray(`[mindmap] Replayed ${applied} patches (${skipped} skipped)`));
    }
  }
  
  return mindmap;
}
```

### 3.3 Patch Lifecycle

```
STARTUP:
  Load mindmap.json → base tree (in memory: is_mycc=true, is_patch=false)
  Replay mindmap-patch.jsonl (hash-matched) → merged in-memory tree
  Hash-check (existing logic — warn if mismatch, no auto-compile)

DURING SESSION:
  recap → forkChat → one patch action
    → applyPatchAction (in-memory) + appendPatch (jsonl) — simultaneously

NEXT STARTUP:
  Same as above — patches replayed from jsonl

/mindmap compile:
  1. compile_mindmap(MYCC.md) → new mindmap.json (foreground)
  2. Patch rebuild: BFS in-memory tree → clean jsonl (dedup, remove stale)
  3. Reload: new mindmap.json + clean patches → new in-memory tree
```

### 3.4 Why patches are hash-gated

Each patch records `mindmap_hash` = the hash of mindmap.json at the time the patch was created. At replay:
- If `patch.mindmap_hash === mindmap.hash` → patch is valid, apply it
- If `patch.mindmap_hash !== mindmap.hash` → patch was created against an older version of mindmap.json, skip it (paths may no longer exist)

After `/mindmap compile`, mindmap.json gets a new hash. The patch rebuild step generates new patches with the new hash, so they're valid for the new version.

### 3.5 Files (as shipped)

| File | Role |
|------|------|
| `src/loop/agent-repl.ts` | Mindmap loading with patch replay (`loadMindmapWithPatches`). Keeps existing hash-check. |
| `src/mindmap/patch-jsonl.ts` | `appendPatch()`, `readAllPatches()`, `writePatches()` (full rewrite), `rebuildPatches()`, `getPatchPath()` |

---

## Part 4: `/mindmap` Slash Command Updates

### 4.1 `/mindmap compile` (updated)

Now does compile + patch rebuild:

```typescript
async function handleCompile(context, remaining) {
  // 1. Compile MYCC.md → mindmap.json (foreground, as now)
  const mindmap = await compile_mindmap(sourceFile, workDir, outputFile);
  
  // 2. Patch rebuild
  const patchPath = getPatchPath(workDir);
  const baseTree = mindmap;  // freshly compiled
  const currentMerged = context.ctx.core.getMindmap() || mindmap;  // in-memory (may have patches)
  
  const cleanPatches = rebuildPatches(currentMerged.root, baseTree.root, mindmap.hash);
  writePatches(cleanPatches, patchPath);  // replace jsonl
  
  // 3. Reload in-memory
  const reloaded = loadMindmapWithPatches(workDir);
  if (reloaded) context.ctx.core.setMindmap(reloaded);
  
  console.log(chalk.green(`✓ Compiled: ${countNodes(mindmap.root)} nodes, ${cleanPatches.length} patches rebuilt`));
}
```

### 4.2 New: `/mindmap rebuild-patches`

Standalone patch rebuild without recompiling:
```
/mindmap rebuild-patches
```
Takes current in-memory tree, does BFS, rewrites jsonl. Useful if jsonl has grown large or suspect.

---

## Architecture Summary

```
┌──────────────────────────────────────────────────────┐
│                      DISK                             │
│                                                       │
│  ┌─────────────────┐    ┌──────────────────────┐    │
│  │  mindmap.json    │    │  mindmap-patch.jsonl  │    │
│  │  (from MYCC.md)  │    │  (from recap patches) │    │
│  │  (MYCC.md source) │    │  append-only log      │    │
│  │  has summaries   │    │  add/update/delete    │    │
│  └────────┬─────────┘    └──────────┬────────────┘   │
│           │                         │                  │
│        Line 1                   Line 2                │
│           │                         │                  │
└───────────┼─────────────────────────┼──────────────────┘
            │                         │
            ▼                         ▼
┌──────────────────────────────────────────────────────┐
│                   STARTUP (in memory)                 │
│  1. Load mindmap.json                                │
│  2. Replay mindmap-patch.jsonl (hash-matched)        │
│  3. Merged in-memory tree → ctx.core.setMindmap()    │
│  4. Hash-check (existing — warn if mismatch)         │
└──────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────┐
│                   DURING SESSION                      │
│                                                       │
│  ┌──────────────────┐   ┌───────────────────────┐   │
│  │  recall tool      │   │  checkpoint → recap    │   │
│  │  (reads in-mem    │   │  forkChat #1: summary  │   │
│  │   merged tree)    │   │  forkChat #2: patch    │   │
│  └──────────────────┘   │   (validate + retry)   │   │
│                          │   apply in-memory       │   │
│                          │   + append to jsonl     │   │
│                          └───────────────────────┘   │
└──────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────┐
│              /mindmap compile                         │
│  1. compile_mindmap(MYCC.md) → new mindmap.json     │
│     (foreground, synchronous — same as now)          │
│  2. Patch rebuild:                                    │
│     BFS in-memory tree → clean jsonl                 │
│     (dedup, remove stale/duplicate patches)          │
│  3. Reload: new mindmap.json + clean patches         │
│     → new in-memory tree                             │
└──────────────────────────────────────────────────────┘
```

---

## Implementation (shipped)

The implementation was completed in this order, all files now exist in `src/`:

1. **`src/mindmap/types.ts`** — `is_mycc: boolean` and `is_patch: boolean` on `Node` (in-memory only); `MindmapPatchAction` interface
2. **`src/mindmap/load.ts`** — Sets `is_mycc = true, is_patch = false` on every node during `load_mindmap` / `load_mindmap_from_json`; strips flags before serialization
3. **`src/mindmap/patch-jsonl.ts`** — `validatePatchAction()`, `appendPatch()`, `readAllPatches()`, `writePatches()`, `rebuildPatches()`, `clearPatches()`, `getPatchPath()`
4. **`src/mindmap/patch.ts`** — `applyPatchAction()` (pure in-memory, no LLM, sets `is_mycc`/`is_patch` flags)
5. **`src/loop/checkpoint-recap.ts`** — `handleRecap` (forkChat #1, unchanged). `generatePatchAction` (forkChat #2, concurrent, with validation + retry). `handleRecapWithPatch` wrapper.
6. **`src/loop/states/hook.ts`** — After `handleRecapWithPatch`, applies patch (in-memory + jsonl simultaneously)
7. **`src/loop/agent-repl.ts`** — Mindmap loading with patch replay. Keeps existing hash-check.
8. **`src/tools/recall.ts`** — Shows `[M]`/`[P]` marker in output, hoisted term collection at root
9. **`src/slashes/mindmap.ts`** — `/mindmap compile` does patch rebuild; `/mindmap rebuild-patches` standalone
10. **`src/mindmap/index.ts`** — Exports all functions
11. **`src/context/teammate-worker.ts`** — Teammate recap also applies patches

---

## Key Design Decisions

1. **Two independent lines on disk** — mindmap.json and mindmap-patch.jsonl never mix on disk. Merge happens only in memory at load time. Clean separation of concerns.

2. **Foreground compile** — no background/async complexity. Compile is synchronous, same as current behavior. User runs `/mindmap compile` when needed.

3. **Patch rebuild during compile** — BFS traversal of in-memory tree generates a clean, minimal jsonl. Eliminates duplicates, stale patches, and cancelled-out operations. This is garbage collection for the patch line.

4. **Hash-gated patch replay** — each patch records the mindmap.json hash it was created against. At replay, only hash-matching patches are applied. After recompile (new hash), old patches are naturally invalid — the rebuild step creates new patches with the new hash.

5. **Two concurrent forkChat calls per recap** — forkChat #1 produces the recap summary (unchanged from current behavior, proven prompt). forkChat #2 produces the patch decision (focused prompt, easy to validate). Both fork from the same triologue state and run concurrently via `Promise.all` — neither depends on the other's output. Separating them ensures the LLM has a single objective per call → more stable responses. Each has its own retry loop.

6. **Simultaneous in-memory + jsonl update** — when a patch is produced, both the in-memory tree and the jsonl are updated. The jsonl is the source of truth; in-memory is ephemeral.

7. **No file watch** — startup hash-check only, same as existing logic. Simple and predictable.

8. **`is_mycc` and `is_patch` are in-memory only** — never serialized to mindmap.json. `is_mycc` is implied by "came from mindmap.json" (set to `true` at load time). `is_patch` marks nodes touched by patches (set during patch replay). These flags drive the rebuild logic: `is_patch: true` on an `is_mycc` node means recompile must preserve the patched text via an `update` action.

9. **No LLM during patch application** — patches are pure data operations. No cascading summary regeneration. Summaries are only generated during `/mindmap compile`.

---

## Backward Compatibility

- **Existing mindmap.json**: no change needed — `is_mycc`/`is_patch` are in-memory only, never in the JSON. `load_mindmap` sets them as defaults.
- **No mindmap-patch.jsonl**: first startup = just load mindmap.json normally (no patches to replay)
- **`/mindmap compile`**: still works, now also does patch rebuild
- **`/mindmap patch`**: still works for manual patching
- **Existing tests**: no `is_mycc`/`is_patch` in JSON serialization. `compile_mindmap_from_content` unchanged (JSON output has no flags).
- **Hash check at startup**: unchanged — if MYCC.md hash ≠ stored hash, shows warning (user can `/mindmap compile`)