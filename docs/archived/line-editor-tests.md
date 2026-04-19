# LineEditor Test Cases

## Workflow

**When fixing bugs:** Always re-run ALL previous tests (regression testing) before considering a fix complete.

---

## Test 1: 40 character input at 40 column width

**Width:** 40 columns

**Input:** `0123456789012345678901234567890123456789` (40 chars)

**Expected:**
- Prompt line spans 2 rows downward
- No duplicated or eaten lines
- Line 1: `agent >> ` + 30 chars (full width)
- Line 2: 10 remaining chars

| Run | Result | Notes |
|-----|--------|-------|
| 1 | ✓ PASS | Initial implementation |
| 2 | ✓ PASS | After key-parser fix |

**Display:**
```
agent >> 0123456789012345678901234567890
123456789
```

---

## Test 2: Cursor movement back to first line

**Width:** 40 columns
**Precondition:** 40 chars already entered (from Test 1)

**Action:** Press Left arrow 11 times (to move cursor from end of line 2 to end of line 1)

**Expected:**
- Cursor moves back 11 positions (from end of line 2 to position 30 on line 1)
- No duplicated or eaten lines
- Neighboring lines unaffected

| Run | Result | Notes |
|-----|--------|-------|
| 1 | ✗ FAIL | Line duplication bug (pre-key-parser fix) |

---

## Test 3: Backspace editing

**Width:** 40 columns
**Precondition:** 40 chars entered (from Test 1)

**Action:** Press Backspace 10 times

**Expected:**
- Content reduced from 40 to 30 chars
- Display shows single line with 30 chars

| Run | Result | Notes |
|-----|--------|-------|
| 1 | ✗ FAIL | Pre-key-parser fix |
| 2 | ✓ PASS | After key-parser fix (parseKeys handles multi-byte buffers) |

**Display:**
```
agent >> 012345678901234567890123456789
```

---

## Test 4: Enter key submission

**Action:** Type text and press Enter

**Expected:**
- LineEditor calls `onDone` callback
- Agent receives input and starts processing

| Run | Result | Notes |
|-----|--------|-------|
| 1 | ✗ FAIL | Enter not recognized (pre-key-parser fix) |
| 2 | ✓ PASS | After key-parser fix |

---

## Key Bug Fixes

### Bug: Multi-byte buffer handling

**Problem:** When typing fast or using tmux send-keys, multiple characters arrive in one buffer (e.g., `"hi\r"`). The old `parseKey()` treated this as a single unknown sequence.

**Fix:** Created `parseKeys()` function that:
1. Uses hex comparison (`toString('hex')`) for control characters
2. Iterates through individual bytes
3. Returns array of KeyInfo, one per key
4. Handles Enter (0x0d) and Backspace (0x7f/0x08) before Ctrl characters

### Bug: Enter key showing as Ctrl+M

**Problem:** Enter (0x0d = 13) was being matched as Ctrl+M (code 13 is in 1-26 range).

**Fix:** Check for Enter/Return before checking Ctrl character range.

### Bug: Backspace not recognized

**Problem:** Backspace (0x7f) wasn't handled in key-parser.

**Fix:** Added Backspace handling with both 0x7f and 0x08 codes.