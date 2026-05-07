# Metadata Refactor: Removed isTestFile Property

## Summary

Removed the `isTestFile` metadata property from the hook system and replaced it with a more generic and flexible approach using `filePath.includes()` in conditions.

## Changes Made

### 1. **Removed `isTestFile` from Metadata** (`src/hook/hook-preprocessor.ts`)
   - **Before**: `metadata.isTestFile = metadata.filePath?.includes('.test.') || metadata.filePath?.includes('.spec.')`
   - **After**: Property removed entirely
   - **Reason**: This was too specific and not generic enough for different project structures

### 2. **Updated Interface** (`src/hook/hook-executor.ts`)
   - Removed `isTestFile?: boolean` from the `AugmentedToolCall.metadata` interface

### 3. **Updated Test Mocks** (`src/hook/condition-validator.ts`)
   - Removed `isTestFile: true` from mock call context

### 4. **Updated Documentation** (`src/hook/conditions.ts`)
   - Removed `call.metadata.isTestFile` from the available metadata documentation
   - Updated example to use `call.metadata.filePath.includes('/tests/')`

### 5. **Updated Condition** (`.mycc/conditions.json`)
   - **Before**: `"condition": "call.metadata.isTestFile && call.metadata.newLoc > 300"`
   - **After**: `"condition": "call.metadata.filePath.includes('/tests/') && call.metadata.newLoc > 300"`

### 6. **Added Tests** (`src/tests/filePath-condition.test.ts`)
   - Tests for the new filePath-based condition approach
   - Verifies test file detection with different patterns

## Benefits

✅ **More Generic**: Conditions can now define their own test file detection logic  
✅ **More Flexible**: Different projects can use different patterns (e.g., `/tests/`, `.test.`, `.spec.`)  
✅ **Less Coupling**: Metadata doesn't enforce a specific definition of "test file"  
✅ **More Powerful**: Can combine multiple patterns (e.g., `filePath.includes('/tests/') || filePath.includes('.test.')`)  

## Example Usage

### Before (with isTestFile):
```json
{
  "condition": "call.metadata.isTestFile && call.metadata.newLoc > 300"
}
```

### After (with filePath):
```json
{
  "condition": "call.metadata.filePath.includes('/tests/') && call.metadata.newLoc > 300"
}
```

### More Complex Example:
```json
{
  "condition": "(call.metadata.filePath.includes('/tests/') || call.metadata.filePath.includes('.test.')) && call.metadata.newLoc > 300"
}
```

## Testing

All tests pass:
- ✅ 71 test files
- ✅ 1271 tests passed
- ✅ New filePath-based condition tests added
- ✅ Existing conditions work correctly
- ✅ No lint errors