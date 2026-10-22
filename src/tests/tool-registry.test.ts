/**
 * tool-registry.test.ts — invariants over the built-in tool registry.
 *
 * One test for ALL tools instead of one hand-written metadata test per
 * tool file. Each `src/tests/tools/*.test.ts` used to re-assert the `name`,
 * `scope` and `input_schema.required` literals of its own tool; those
 * assertions could not catch a registry-wide problem (duplicate name, a
 * tool file that is never registered, a registry entry with no backing
 * file). This file asserts the invariants once, against the single source
 * of truth: `builtInTools`.
 *
 * Behaviour of each tool is still covered by its own test file — this file
 * only owns the *contract* of the tool definition itself.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtInTools } from '../context/shared/registry.js';

const TOOLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tools'
);

/** Files in src/tools/ that are infrastructure, not tool definitions. */
const NON_TOOL_FILES = new Set(['types.ts', 'index.ts']);

const REGISTRY_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../context/shared/registry.ts'
);

/**
 * File names (relative to src/tools/) that registry.ts imports tool
 * definitions from, e.g. `import { bashTool } from '../../tools/bash.js'`
 * yields `bash.ts`.
 */
function registrySources(): Set<string> {
  const code = fs.readFileSync(REGISTRY_FILE, 'utf8');
  const re = /import\s*\{[^}]*\b\w+Tool\b[^}]*\}\s*from\s*'\.\.\/\.\.\/tools\/([\w-]+)\.js'/g;
  const out = new Set<string>();
  for (const m of code.matchAll(re)) out.add(`${m[1]}.ts`);
  return out;
}

/** The scope vocabulary used across src/tools/*.ts. */
const VALID_SCOPES = new Set(['main', 'child', 'bg']);

describe('builtInTools registry', () => {
  it('registers every tool with a well-formed name', () => {
    for (const tool of builtInTools) {
      expect(tool.name, `empty name in ${tool.name}`).toBeTruthy();
      expect(tool.name, `name "${tool.name}" must be snake_case`).toMatch(
        /^[a-z][a-z0-9_]*$/
      );
    }
  });

  it('has no duplicate tool names', () => {
    const names = builtInTools.map((t) => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it('declares a non-empty description of meaningful length', () => {
    for (const tool of builtInTools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.description.length, `${tool.name} description too short`)
        .toBeGreaterThanOrEqual(20);
    }
  });

  it('declares a non-empty scope drawn from the known vocabulary', () => {
    for (const tool of builtInTools) {
      expect(tool.scope.length, `${tool.name} has empty scope`)
        .toBeGreaterThan(0);
      for (const s of tool.scope) {
        expect(VALID_SCOPES.has(s), `${tool.name} has unknown scope "${s}"`)
          .toBe(true);
      }
    }
  });

  it('declares an object input_schema whose required keys exist', () => {
    for (const tool of builtInTools) {
      const schema = tool.input_schema;
      expect(schema.type, `${tool.name} schema.type`).toBe('object');
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      for (const req of schema.required ?? []) {
        expect(Object.keys(props), `${tool.name} requires undeclared "${req}"`)
          .toContain(req);
      }
    }
  });

  it('has a backing source file for every registered tool', () => {
    // The registry imports each tool from a module whose file name does not
    // always equal the tool's `name` (e.g. `read_file` lives in read.ts), so
    // the invariant is checked against the import specifiers instead.
    const sources = registrySources();
    expect(sources.size, 'no tool imports found in registry.ts').toBeGreaterThan(0);
    for (const source of sources) {
      expect(fs.existsSync(path.join(TOOLS_DIR, source)), `missing src/tools/${source}`)
        .toBe(true);
    }
  });

  it('registers every tool source file in src/tools/', () => {
    const registered = new Set(registrySources());
    const onDisk = fs
      .readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith('.ts') && !NON_TOOL_FILES.has(f));
    const unregistered = onDisk.filter((f) => !registered.has(f));
    expect(unregistered, 'tool files missing from builtInTools').toEqual([]);
  });
});
