# Final Plan: Disk-Based Multi-Focus Image Cache with M Token

> Refined by team review + user specification.

## Problem

`read_picture` re-invokes the vision model every time the same image is read. The LLM sometimes reads the same picture multiple times, wasting expensive vision calls. Once described, the parsed text should be reused. Multiple focus questions should accumulate via an explicit M (merge) token.

## Design: M-Token Multi-Focus Accumulator at Core Level

### M Token Mechanics

M is a **cache token** — a hash that encodes the current state of the cache entry (which focuses have been accumulated). It is returned to the LLM and passed back to authorize adding a new focus.

```
M = JSON.stringify([normalized_file_path, focus1, focus2, ..., focusN])
```
using the SHA-256 hash of that JSON string. JSON.stringify (not plain join) is used so focus boundaries are preserved — `["a","bc"]` and `["ab","c"]` would collide under plain join.

- `M1 = hash(JSON.stringify([path, focus1]))` after 1st read
- `M2 = hash(JSON.stringify([path, focus1, focus2]))` after 2nd read with M1 + new prompt
- `MN = hash(JSON.stringify([path, focus1, ..., focusN]))` after N-th merge

### The Flow

```
read_picture(path, prompt?, cache=M_token?)
  │
  ├─ Validate path, check exists, check extension (tool layer, unchanged)
  ├─ Call ctx.core.readPictureCached(absolutePath, prompt?, cacheToken?)
  │
  │  ┌─ Core.readPictureCached (parent process owns cache files):
  │  │
  │  │  1. statSync → statKey = `${mtimeMs}|${size}`
  │  │  2. cacheFile = getCacheFilePath(absolutePath)
  │  │  3. Read cache file → entry (null if missing/corrupt/stale)
  │  │  4. focus = prompt || "general description"
  │  │
  │  │  ┌─ Cache MISS (no entry or statKey mismatch):
  │  │  │   → vision call (imgDescribe) with prompt/default
  │  │  │   → write cache file: { statKey, pairs: [{focus, desc}] }
  │  │  │   → compute M = hash(path + focus)
  │  │  │   → return { pairs, cacheToken: M }
  │  │  │
  │  │  ┌─ Cache HIT, NO cache token passed:
  │  │  │   → NO vision call (prompt ignored — LLM must pass M to add focus)
  │  │  │   → compute M_current = hash(path + all existing focuses)
  │  │  │   → return { pairs: entry.pairs, cacheToken: M_current }
  │  │  │
  │  │  ┌─ Cache HIT, cache token passed (M matches M_current):
  │  │  │   → Check if focus EXISTS in entry.pairs (exact string match)
  │  │  │   ├─ EXISTS → NO vision call
  │  │  │   │   → return { pairs: entry.pairs, cacheToken: M_current }
  │  │  │   └─ NEW   → vision call (imgDescribe) with prompt
  │  │  │       → add pair to entry.pairs
  │  │  │       → atomic write cache file
  │  │  │       → compute M_new = hash(path + all focuses including new)
  │  │  │       → return { pairs: entry.pairs, cacheToken: M_new }
  │  │  │
  │  │  ┌─ Cache HIT, cache token passed but STALE (M ≠ M_current):
  │  │  │   → NO vision call (token is stale — cache has changed since LLM last saw it)
  │  │  │   → return { pairs: entry.pairs, cacheToken: M_current }
  │  │  │   (LLM gets current state + fresh token; can retry with M_current to add focus)
  │  │
  │  └─ Child process: delegates via IPC to parent's Core.readPictureCached()
  │
  ├─ Format result string from { pairs, cacheToken }
  └─ Return to LLM
```

### Key Rules

1. **Without M token**: cache hit → return cached pairs + M_current. No vision call. Prompt is ignored. The LLM must pass M back to add a new focus.
2. **With M token (valid)**: cache hit + new focus → vision call, add pair, return all pairs + new M. Cache hit + existing focus → no vision call, return all pairs + same M.
3. **With M token (stale)**: cache hit → no vision call, return current pairs + M_current (LLM gets fresh token).
4. **Cache miss**: always vision call, write cache, return pairs + M. (M token passed or not is irrelevant on miss.)
5. **No semantic match**: focus matching is exact string comparison (case-sensitive, after trim only). The LLM controls focus labels via prompts.
6. **Focus label**: the prompt string, or `"general description"` if no prompt given.

### Return Format

**1st read (cache miss):**
```
## Image: img.png

[general description]: The image shows a login form with two input fields...

---
💡 Cache token: a1b2c3d4e5f67890
To ask a different question about this image, call read_picture again with cache="a1b2c3d4e5f67890" and your new prompt.
```

**2nd read, no cache token (cache hit, no vision call):**
```
## Image: img.png (cached — not re-read)

[general description]: The image shows a login form with two input fields...

---
💡 Cache token: a1b2c3d4e5f67890
To ask a different question about this image, call read_picture again with cache="a1b2c3d4e5f67890" and your new prompt.
```

**2nd read with M1 + new prompt (cache hit, new focus added):**
```
## Image: img.png (cache merged — new focus added)

[general description]: The image shows a login form with two input fields...

[What text is visible?]: The visible text includes "Username", "Password", "Login"...

---
💡 Cache token: f9e8d7c6b5a43210
To ask another question, call read_picture again with cache="f9e8d7c6b5a43210" and your new prompt.
```

**2nd read with M1 + existing prompt (cache hit, focus exists, no vision call):**
```
## Image: img.png (cached — focus already exists, not re-read)

[general description]: The image shows a login form with two input fields...

---
💡 Cache token: a1b2c3d4e5f67890
To ask a different question, call read_picture again with cache="a1b2c3d4e5f67890" and your new prompt.
```

## Architecture: Core Level (not tool level)

The cache lives in the **parent's Core** class — NOT in the tool layer, NOT in `imgDescribe`. This ensures:
- **Only the parent process touches cache files** — children delegate via IPC. No concurrency races.
- **`imgDescribe` stays a stateless low-level API** — the cache logic is a higher-level concern.
- **Shared cache across all agents** (lead + teammates) — all go through the parent's Core.

### New CoreModule Method

Add to `CoreModule` interface in `src/types.ts`:

```typescript
/** Result from cached image reading */
interface PictureResult {
  pairs: Array<{ focus: string; description: string }>;
  cacheToken: string;
}

/**
 * Read an image with multi-focus caching. Returns accumulated [focus, description]
 * pairs and a cache token (M). Pass the token back to add a new focus.
 * @param imagePath - Absolute path to the image file
 * @param prompt - Optional prompt (becomes the focus label; defaults to "general description")
 * @param cacheToken - Optional M token from a previous read; authorizes adding a new focus
 */
readPictureCached(
  imagePath: string,
  prompt?: string,
  cacheToken?: string,
): Promise<PictureResult>;
```

### Implementation: Parent's Core (`src/context/parent/core.ts`)

```typescript
// New imports
import { createHash } from 'crypto';
import { getImgCacheDir } from '../../config.js';

// New types (file-local)
interface FocusPair { focus: string; description: string; }
interface PictureCacheEntry {
  statKey: string;
  pairs: FocusPair[];
}

// New private field
private pictureCacheDir: string;

// In constructor: this.pictureCacheDir = getImgCacheDir();

// New helper methods (private):

// Normalize path for hashing: backslash→slash, lowercase drive, strip trailing slash
private normalizeForHash(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (/^[A-Z]:\//.test(n)) n = n[0].toLowerCase() + n.slice(1);
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

// Cache file path = .mycc/imgcache/<sha256-16hex>.json
private getCacheFilePath(absolutePath: string): string {
  const hash = createHash('sha256').update(this.normalizeForHash(absolutePath)).digest('hex').slice(0, 16);
  return path.join(this.pictureCacheDir, `${hash}.json`);
}

// Compute M token from path + all focuses (in order)
private computeCacheToken(absolutePath: string, focuses: string[]): string {
  const normalizedPath = this.normalizeForHash(absolutePath);
  return createHash('sha256').update(normalizedPath + focuses.join('')).digest('hex').slice(0, 16);
}

// Read cache file; null if missing/corrupt
private readCacheFile(filePath: string): PictureCacheEntry | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry = JSON.parse(raw) as PictureCacheEntry;
    if (!entry.statKey || !Array.isArray(entry.pairs)) return null;
    return entry;
  } catch { return null; }
}

// Atomic write: PID-suffixed temp + rename
private writeCacheFile(filePath: string, entry: PictureCacheEntry): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(entry, null, 2));
  fs.renameSync(tempPath, filePath);
}

// New public method:
async readPictureCached(
  imagePath: string,
  prompt?: string,
  cacheToken?: string,
): Promise<PictureResult> {
  const focus = (prompt || 'general description').trim();
  const stat = fs.statSync(imagePath);
  const statKey = `${stat.mtimeMs}|${stat.size}`;
  const cacheFile = this.getCacheFilePath(imagePath);

  const entry = this.readCacheFile(cacheFile);
  const cacheHit = entry && entry.statKey === statKey;

  if (!cacheHit) {
    // Cache miss: vision call, write fresh entry
    const description = await this.imgDescribe(imagePath, prompt);
    const newEntry: PictureCacheEntry = { statKey, pairs: [{ focus, description }] };
    this.writeCacheFile(cacheFile, newEntry);
    const token = this.computeCacheToken(imagePath, [focus]);
    return { pairs: newEntry.pairs, cacheToken: token };
  }

  // Cache hit: compute current token
  const currentFocuses = entry.pairs.map(p => p.focus);
  const currentToken = this.computeCacheToken(imagePath, currentFocuses);

  // No cache token passed: return cached pairs, no vision call
  if (!cacheToken) {
    return { pairs: entry.pairs, cacheToken: currentToken };
  }

  // Cache token passed but stale: return current state, no vision call
  if (cacheToken !== currentToken) {
    return { pairs: entry.pairs, cacheToken: currentToken };
  }

  // Cache token valid: check if focus exists (exact match, trimmed)
  const existing = entry.pairs.find(p => p.focus.trim() === focus);

  if (existing) {
    // Focus exists: no vision call
    return { pairs: entry.pairs, cacheToken: currentToken };
  }

  // New focus: vision call, add pair
  const description = await this.imgDescribe(imagePath, prompt);
  entry.pairs.push({ focus, description });
  this.writeCacheFile(cacheFile, entry);
  const newToken = this.computeCacheToken(imagePath, [...currentFocuses, focus]);
  return { pairs: entry.pairs, cacheToken: newToken };
}
```

### Implementation: Child's Core (`src/context/child/core.ts`)

Delegate via IPC — same pattern as `imgDescribe`:

```typescript
async readPictureCached(
  imagePath: string,
  prompt?: string,
  cacheToken?: string,
): Promise<PictureResult> {
  const response = await ipc.sendRequest<PictureResult>('core_read_picture_cached', {
    imagePath, prompt, cacheToken,
  });
  return response;
}
```

### IPC Handler (`src/context/parent-context.ts`)

Add new handler in `initializeIpcHandlers()`:

```typescript
{
  messageType: 'core_read_picture_cached',
  module: 'core',
  handler: async (_sender, payload, ctx, sendResponse) => {
    const { imagePath, prompt, cacheToken } = payload as {
      imagePath: string; prompt?: string; cacheToken?: string;
    };
    try {
      const result = await ctx.core.readPictureCached(imagePath, prompt, cacheToken);
      sendResponse('core_result', true, result);
    } catch (err) {
      sendResponse('core_result', false, undefined, (err as Error).message);
    }
  },
},
```

## Files to Change

### 1. `src/types.ts` — Add `PictureResult` type and `readPictureCached` method to `CoreModule`

```typescript
/** Result from cached image reading */
interface PictureResult {
  pairs: Array<{ focus: string; description: string }>;
  cacheToken: string;
}
```

Add `readPictureCached()` to the `CoreModule` interface.

### 2. `src/config.ts` — Add `getImgCacheDir()` helper

```typescript
export function getImgCacheDir(): string {
  return path.join(MYCC_DIR, 'imgcache');
}
```

Add `getImgCacheDir()` to the `dirs` array in `ensureDirs()`.

### 3. `src/context/parent/core.ts` — Implement `readPictureCached()`

Add all the helper methods and the public method described above. Import `createHash`, `getImgCacheDir`.

### 4. `src/context/child/core.ts` — Delegate `readPictureCached()` via IPC

Same pattern as `imgDescribe`.

### 5. `src/context/parent-context.ts` — Add IPC handler for `core_read_picture_cached`

### 6. `src/tools/read-picture.ts` — Thin wrapper

- Add `cache` parameter to `input_schema` (type: string, description: "Cache token from a previous read. Pass it back with a new prompt to add a new focus to the cached image.")
- Handler: validate path → call `ctx.core.readPictureCached(safe, prompt, cacheToken)` → format result string with pairs + hint
- Remove direct `imgDescribe` call (now inside Core)

### 7. `src/tests/tools/read-picture.test.ts` — New test file

Test cases:
1. First read (cache miss) — calls `readPictureCached` once, returns description + M token
2. Second read, no cache token (cache hit) — returns cached pairs + same M, no extra vision call (mock `readPictureCached` returns same pairs)
3. Second read with M + new prompt — returns 2 pairs + new M
4. Second read with M + existing prompt — returns same pairs + same M
5. Stale M token — returns current pairs + current M
6. File changes — cache invalidated, new vision call
7. First read with prompt — stores actual prompt as focus
8. Path traversal blocked
9. Non-existent file
10. Tool metadata (name, scope, cache param in schema)

### 8. Mock context updates

`src/tests/tools/test-utils.ts` and `src/tests/test-utils/mock-context.ts` — add `readPictureCached` mock.

### 9. No changes to:
- `src/tools/screen.ts` — uses `imgDescribe` directly, no cache (temp file, always fresh)
- `src/engine/ollama.ts`, `src/engine/deepseek.ts` — engine stays stateless

## Implementation Steps

1. Add `PictureResult` type + `readPictureCached` to `CoreModule` in `src/types.ts`
2. Add `getImgCacheDir()` to `src/config.ts`, register in `ensureDirs()`
3. Implement `readPictureCached()` + helpers in `src/context/parent/core.ts`
4. Delegate `readPictureCached()` via IPC in `src/context/child/core.ts`
5. Add IPC handler in `src/context/parent-context.ts`
6. Rewrite `src/tools/read-picture.ts` as thin wrapper with `cache` parameter
7. Update mocks in `src/tests/tools/test-utils.ts` and `src/tests/test-utils/mock-context.ts`
8. Create `src/tests/tools/read-picture.test.ts`
9. Run `pnpm typecheck`
10. Run `pnpm test src/tests/tools/read-picture.test.ts`
11. Run `pnpm lint`
12. Commit

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Cache miss (no file or stale statKey) | Vision call, write cache, return pairs + M |
| Cache hit, no cache token | Return cached pairs + M_current, no vision call (prompt ignored) |
| Cache hit, valid M + new focus | Vision call, add pair, return all pairs + new M |
| Cache hit, valid M + existing focus | No vision call, return all pairs + same M |
| Cache hit, stale M | No vision call, return current pairs + M_current |
| File overwritten (mtime changed) | statKey mismatch → cache miss → overwrite |
| Corrupt cache file | try/catch → null → cache miss → overwrite |
| First read with prompt | Store actual prompt as focus |
| First read without prompt | Store "general description" as focus |
| Focus matching | Exact string match (trimmed, case-sensitive) — no normalization |
| Concurrent access | Only parent touches cache files; children IPC to parent — no races |
| Symlinks | Keyed by accessed path (lexical resolution) |
| screen.ts | Uses imgDescribe directly, unaffected |