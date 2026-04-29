---
name: test-file-line-limit
when: before writing a test file, check if it exceeds 300 lines and block if so
---

# Test File Line Limit

Enforce that all test files (*.test.ts, *.spec.ts) are under 300 lines-of-code.

## Why

- Large test files are hard to maintain and navigate
- Smaller test files encourage focused, modular testing
- 300 lines is a reasonable threshold for a single test module

## Enforcement

When writing a test file that would exceed 300 lines:
1. Block the write operation
2. Suggest splitting into smaller test modules
3. Group related tests by functionality or feature

## Exceptions

None. If a test file truly needs more than 300 lines, consider:
- Extracting shared test utilities
- Creating separate test files for different scenarios
- Using test fixtures or factories to reduce setup code