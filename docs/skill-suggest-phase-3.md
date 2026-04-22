# Phase 3: Triologue Temporary Hint

## Goal

Add temporary hint support to Triologue - hints appear in `getMessages()` but NOT in transcripts.

## Files to Modify

- `src/loop/triologue.ts` - Add field, methods, modify `getMessages()` and `addMessage()`

## Implementation

### 3.1 Add Temporary Hint Field and Methods

**File: `src/loop/triologue.ts`**

Add skill hint as a temporary field in the class:

```typescript
// Add to class fields (near other private fields)
private temporaryHint: string | null = null;

/**
 * Set a temporary hint to be appended to the last user message.
 * The hint appears in getMessages() output but NOT in transcripts.
 * Only works when the last message is from user.
 * @param hint - The hint text to append, or null to clear
 */
setTemporaryHint(hint: string | null): void {
  this.temporaryHint = hint;
}

/**
 * Clear the temporary hint
 */
clearTemporaryHint(): void {
  this.temporaryHint = null;
}
```

### 3.2 Clear Hint When New Messages Added

**File: `src/loop/triologue.ts`** (in `addMessage()` method)

Add clearing of temporary hint at the start:

```typescript
private async addMessage(message: Message): Promise<void> {
  // Clear temporary hint when history builds up (new message added)
  this.temporaryHint = null;
  
  this.messages.push(message);
  this.updateTokenCount(message);

  // Call onMessage callback if set
  if (this.options.onMessage) {
    this.options.onMessage(this.messages);
  }

  // Check for auto-compact
  if (this.tokenCount > this.options.tokenThreshold) {
    await this.compact();
  }
}
```

### 3.3 Include Hint in `getMessages()`

**File: `src/loop/triologue.ts`** (modify `getMessages()` method)

Append temporary hint to the last user message:

```typescript
getMessages(): Message[] {
  const result: Message[] = [];

  if (this.systemPrompt) {
    result.push({ role: 'system', content: this.systemPrompt });
  }

  // Inject project context
  result.push(...this.projectContext);

  // Add messages, appending temporary hint to last user message if present
  for (let i = 0; i < this.messages.length; i++) {
    const msg = this.messages[i];
    
    // Append temporary hint to the last user message (for LLM, not transcript)
    // Only if the last message is from user (hint should not appear after assistant/tool)
    const lastMsg = this.messages[this.messages.length - 1];
    if (msg.role === 'user' && i === this.messages.length - 1 && this.temporaryHint && lastMsg.role === 'user') {
      result.push({
        role: 'user',
        content: msg.content + '\n\n' + this.temporaryHint,
      });
    } else {
      result.push(msg);
    }
  }

  return result;
}
```

## Key Behaviors

1. **Temporary**: The hint is stored in `temporaryHint` field, not in `messages` array
2. **Auto-clear**: When `addMessage()` is called (history builds up), the hint is cleared
3. **User-only**: The hint is only appended if the last message is from user
4. **Transcript-safe**: The hint never appears in saved transcripts (jsonl files)

## Verification

1. Run `pnpm typecheck` - should pass
2. Set a temporary hint: `triologue.setTemporaryHint("[hint]test[/hint]")`
3. Check `getMessages()` includes the hint on last user message
4. Call `triologue.user('new message')` - hint should be cleared
5. Check transcript file - hint should NOT appear

## Notes

- The hint content is built by phase 2's `buildSkillHint()` which includes skill descriptions
- Phase 2 uses `SKILL_MATCH_THRESHOLD` config variable for similarity matching
- This phase provides the temporary storage mechanism; the hint format is determined by phase 2