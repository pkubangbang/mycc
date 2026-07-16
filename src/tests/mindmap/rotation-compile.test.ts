/**
 * Tests for rotation-based mindmap compilation
 *
 * Tests the new approach:
 * 1. Always creates a new tree from scratch
 * 2. Pre-populates matching nodes from old tree
 * 3. Saves progress to .new temp file
 * 4. Rotates on completion: main → .bak, .new → main
 * 5. Lock-based resumption with 4h threshold
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { compile_mindmap } from '../../mindmap/compile.js';
import { compute_hash } from '../../mindmap/validate.js';
import { load_mindmap, try_load_mindmap } from '../../mindmap/load.js';
import { create_lock, try_read_lock, remove_lock } from '../../mindmap/compile-utils.js';
import type { Node } from '../../mindmap/types.js';

// Track whether summarizeWithExplorer received existingNode
const summarizeCalls: Array<{ nodeTitle: string; hasExistingNode: boolean }> = [];

vi.mock('../../mindmap/explorer-agent.js', () => ({
  summarizeWithExplorer: vi.fn(
    async (
      nodeTitle: string,
      nodeText: string,
      ancestorContext: string,
      workDir: string,
      onProgress?: unknown,
      existingNode?: Node
    ) => {
      summarizeCalls.push({
        nodeTitle,
        hasExistingNode: !!existingNode,
      });
      const randSuffix = crypto.randomBytes(4).toString('hex');
      return {
        summary: `[A] ${nodeTitle} [N] ${nodeText.slice(0, 40)} [C] ${ancestorContext.slice(0, 30)} [E] ${randSuffix}`,
        markedFiles: [],
        markedUrls: [],
        markedTerms: [],
      };
    }
  ),
}));

describe('rotation-based compile_mindmap', () => {
  let tempDir: string;
  let mdPath: string;
  let outPath: string;
  let newFilePath: string;
  let bakFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-rot-'));
    mdPath = path.join(tempDir, 'TEST.md');
    // Use a custom output path directly in tempDir (not .mycc subdir)
    outPath = path.join(tempDir, 'mindmap.json');
    newFilePath = `${outPath}.new`;
    bakFilePath = `${outPath}.bak`;
    summarizeCalls.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── Hash Persistence ───────────────────────────────────────

  it('should persist the correct hash to disk after rotation compile', async () => {
    const mdContent = `# Overview

Test project.

## Setup

Instructions.

## Architecture

Three layers.
`;
    fs.writeFileSync(mdPath, mdContent);

    const result = await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    const actualHash = compute_hash(mdContent);
    expect(result.hash).toBe(actualHash);

    // Main file should exist with correct hash
    const saved = load_mindmap(outPath);
    expect(saved.hash).toBe(actualHash);

    // .bak file may or may not exist depending on whether there was a previous file
    // .new file should NOT exist (was rotated)
    expect(fs.existsSync(newFilePath)).toBe(false);
  });

  it('should persist hash when no old tree exists (first compile)', async () => {
    const mdContent = '# Only\n\nJust one section.';
    fs.writeFileSync(mdPath, mdContent);

    const result = await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    const actualHash = compute_hash(mdContent);
    expect(result.hash).toBe(actualHash);

    const saved = load_mindmap(outPath);
    expect(saved.hash).toBe(actualHash);
  });

  // ─── Rotation ──────────────────────────────────────────────

  it('should rotate files: main → .bak, .new → main', async () => {
    const mdContent = '# First\n\nFirst content.';
    fs.writeFileSync(mdPath, mdContent);

    // First compile creates the initial mindmap.json
    const firstResult = await compile_mindmap(mdPath, tempDir, 'mindmap.json');
    const firstHash = firstResult.hash;

    // Verify main file exists
    expect(fs.existsSync(outPath)).toBe(true);

    // Change the markdown content
    const newContent = '# Second\n\nSecond content.';
    fs.writeFileSync(mdPath, newContent);

    // Second compile should rotate: old main → .bak, new → main
    const secondResult = await compile_mindmap(mdPath, tempDir, 'mindmap.json');
    const secondHash = secondResult.hash;

    expect(secondHash).not.toBe(firstHash);

    // Main file should have new hash
    const saved = load_mindmap(outPath);
    expect(saved.hash).toBe(secondHash);

    // .bak file should have old hash
    const bak = load_mindmap(bakFilePath);
    expect(bak.hash).toBe(firstHash);

    // .new file should NOT exist
    expect(fs.existsSync(newFilePath)).toBe(false);
  });

  it('should not create .bak on first compile (no original to backup)', async () => {
    const mdContent = '# First\n\nContent.';
    fs.writeFileSync(mdPath, mdContent);

    await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // On first compile, the mindmap.json is created fresh.
    // The rotate_files function renames the existing main to .bak.
    // Since there was no main file before, only .new → main happens.
    expect(fs.existsSync(outPath)).toBe(true);
    // No .bak since there was no original
    expect(fs.existsSync(bakFilePath)).toBe(false);
  });

  // ─── Pre-population ─────────────────────────────────────────

  it('should pre-populate matching nodes from old tree', async () => {
    const mdContent = `# Section A

Content A.

## Subsection B

Content B.
`;
    fs.writeFileSync(mdPath, mdContent);

    // First compile
    await compile_mindmap(mdPath, tempDir, 'mindmap.json');
    const firstCallCount = summarizeCalls.length;

    // Reset tracking
    summarizeCalls.length = 0;

    // Second compile with changed content
    const newContent = `# Section A

Content A updated.

## Subsection B

Content B.
`;
    fs.writeFileSync(mdPath, newContent);

    await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // All nodes should have been pre-populated from old tree
    // (they match paths from the first compile)
    for (const call of summarizeCalls) {
      expect(call.hasExistingNode).toBe(true);
    }
  });

  it('should NOT pre-populate when no old tree exists', async () => {
    const mdContent = '# Fresh\n\nBrand new content.';
    fs.writeFileSync(mdPath, mdContent);

    await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // First compile - no old tree, so no pre-population
    for (const call of summarizeCalls) {
      expect(call.hasExistingNode).toBe(false);
    }
  });

  it('should pre-populate from .bak when main file is missing', async () => {
    const mdContent = '# Section\n\nOriginal content.';
    fs.writeFileSync(mdPath, mdContent);

    // First compile creates main file
    await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // Second compile with different content to create a .bak
    const newContent = '# Section\n\nUpdated content.';
    fs.writeFileSync(mdPath, newContent);
    await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // Now delete main file, keep .bak
    fs.unlinkSync(outPath);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(bakFilePath)).toBe(true);

    // Reset tracking
    summarizeCalls.length = 0;

    // Third compile with different content but same section structure
    const thirdContent = '# Section\n\nThird content.';
    fs.writeFileSync(mdPath, thirdContent);
    await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // Should have pre-populated from .bak (same section path)
    for (const call of summarizeCalls) {
      expect(call.hasExistingNode).toBe(true);
    }
  });

  // ─── Fast Path (hash matches) ────────────────────────────────

  it('should return existing mindmap when hash matches and all nodes complete', async () => {
    const mdContent = '# Stable\n\nUnchanged content.';
    fs.writeFileSync(mdPath, mdContent);

    // First compile
    const firstResult = await compile_mindmap(mdPath, tempDir, 'mindmap.json');
    const firstCallCount = summarizeCalls.length;

    // Reset tracking
    summarizeCalls.length = 0;

    // Second compile with same content - should hit fast path
    const secondResult = await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // Should return the same mindmap (same hash)
    expect(secondResult.hash).toBe(firstResult.hash);

    // Should NOT have called summarizeWithExplorer again
    expect(summarizeCalls.length).toBe(0);
  });

  // ─── Lock-based Resumption ─────────────────────────────────

  it('should resume from temp file when fresh lock exists', async () => {
    // Use different content than the first compile to avoid fast path
    const firstContent = '# First\n\nFirst baseline.';
    fs.writeFileSync(mdPath, firstContent);
    await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // Now use new content for the interrupted compilation
    const mdContent = `# Resume

Test resume.

## Child

Child content.
`;
    fs.writeFileSync(mdPath, mdContent);

    // Now simulate an interrupted compilation:
    // 1. Create a lock file with the new hash
    const hash = compute_hash(mdContent);
    create_lock(outPath, 'TEST.md', hash);

    // 2. Create a partial .new file with some nodes already summarized
    const { parse_markdown, build_node, extract_links } = await import('../../mindmap/compile-utils.js');
    const sections = parse_markdown(mdContent);
    const preamble = '';

    const partialRoot: Node = {
      id: '/',
      text: preamble,
      title: 'TEST',
      summary: '', // root not summarized yet
      level: 0,
      children: sections.map((s) => build_node(s, '/', 1)),
      links: extract_links(preamble),
    };

    // Mark the leaf node as already summarized (simulating partial progress)
    const childNode = partialRoot.children[0].children[0];
    childNode.summary = 'already done summary';

    const partialMindmap = {
      dir: tempDir,
      source_file: 'TEST.md',
      hash,
      compiled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      root: partialRoot,
    };

    fs.writeFileSync(newFilePath, JSON.stringify(partialMindmap, null, 2));

    // Reset tracking
    summarizeCalls.length = 0;

    // Now compile again - should resume from temp file
    const result = await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // Should have correct hash
    expect(result.hash).toBe(hash);

    // Should have called summarizeWithExplorer only for incomplete nodes
    // (root node was not summarized, child was already done)
    const calledTitles = summarizeCalls.map((c) => c.nodeTitle);
    // Root was incomplete, so it should be called
    expect(calledTitles).toContain('TEST');
    // Child was already summarized, so it should NOT be called again
    expect(calledTitles).not.toContain('Child');

    // Clean up lock
    remove_lock(outPath);
  });

  it('should start fresh when lock is stale', async () => {
    const mdContent = '# Stale\n\nStale lock test.';
    fs.writeFileSync(mdPath, mdContent);

    // Create a stale lock file (old timestamp)
    const hash = compute_hash(mdContent);
    const staleLock = {
      started_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
      source_file: 'TEST.md',
      source_hash: hash,
      output_file: outPath,
    };
    const lockPath = `${outPath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify(staleLock, null, 2));

    // Create a stale .new file
    fs.writeFileSync(newFilePath, '{"stale": true}');

    // Reset tracking
    summarizeCalls.length = 0;

    // Compile - should discard stale lock and temp file
    const result = await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    // Should have correct hash
    expect(result.hash).toBe(hash);

    // Should have called summarizeWithExplorer (fresh start)
    expect(summarizeCalls.length).toBeGreaterThan(0);

    // Lock should be removed
    expect(fs.existsSync(lockPath)).toBe(false);

    // .new file should NOT exist (was rotated to main)
    expect(fs.existsSync(newFilePath)).toBe(false);
  });

  // ─── Force Flag ─────────────────────────────────────────────

  it('should discard temp and start fresh when force=true', async () => {
    const mdContent = '# Force\n\nForce test.';
    fs.writeFileSync(mdPath, mdContent);

    // Create a lock and temp file
    const hash = compute_hash(mdContent);
    create_lock(outPath, 'TEST.md', hash);
    fs.writeFileSync(newFilePath, '{"force": true}');

    // Reset tracking
    summarizeCalls.length = 0;

    // Compile with force=true
    const result = await compile_mindmap(mdPath, tempDir, 'mindmap.json', true);

    // Should have correct hash
    expect(result.hash).toBe(hash);

    // Should have called summarizeWithExplorer (fresh start)
    expect(summarizeCalls.length).toBeGreaterThan(0);

    // Lock should be removed
    expect(fs.existsSync(`${outPath}.lock`)).toBe(false);

    // .new file should NOT exist (was rotated to main)
    expect(fs.existsSync(newFilePath)).toBe(false);
  });

  // ─── updated_at ─────────────────────────────────────────────

  it('should update updated_at in the persisted file', async () => {
    const mdContent = '# Main\n\nContent.';
    fs.writeFileSync(mdPath, mdContent);

    const before = new Date();
    await compile_mindmap(mdPath, tempDir, 'mindmap.json');

    const saved = load_mindmap(outPath);
    const savedTime = new Date(saved.updated_at);
    expect(savedTime.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  // ─── Error Handling ────────────────────────────────────────

  it('should clean up lock on compilation error', async () => {
    const mdContent = '# Error\n\nError test.';
    fs.writeFileSync(mdPath, mdContent);

    // Temporarily make summarizeWithExplorer throw
    const explorerModule = await import('../../mindmap/explorer-agent.js');
    const originalMock = explorerModule.summarizeWithExplorer;
    explorerModule.summarizeWithExplorer = vi.fn(async () => {
      throw new Error('Simulated compilation error');
    });

    // Reset tracking
    summarizeCalls.length = 0;

    await expect(compile_mindmap(mdPath, tempDir, 'mindmap.json')).rejects.toThrow('Simulated compilation error');

    // Lock should be removed after error
    expect(fs.existsSync(`${outPath}.lock`)).toBe(false);

    // Restore mock
    explorerModule.summarizeWithExplorer = originalMock;
  });
});
