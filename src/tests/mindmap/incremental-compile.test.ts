/**
 * Tests for incremental_compile hash persistence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { incremental_compile, save_mindmap_atomic } from '../../mindmap/diff-mindmap.js';
import { compute_hash } from '../../mindmap/validate.js';
import { load_mindmap } from '../../mindmap/load.js';
import { parse_markdown, build_node, collect_nodes_bottom_up } from '../../mindmap/compile-utils.js';
import type { MindmapJSON, Node } from '../../mindmap/types.js';

vi.mock('../../mindmap/explorer-agent.js', () => ({
  summarizeWithExplorer: vi.fn(
    async (nodeTitle: string, nodeText: string, ancestorContext: string) => {
      const randSuffix = crypto.randomBytes(4).toString('hex');
      return {
        summary: `[A] ${nodeTitle} [N] ${nodeText.slice(0, 40)} [C] ${ancestorContext.slice(0, 30)} [E] ${randSuffix}`,
        markedFiles: [],
        markedUrls: [],
        markedTerms: [],
      };
    }
  ),
  exploreAndSummarize: vi.fn(),
}));

function makeMinimalMindmap(mdContent: string, oldHash: string): MindmapJSON {
  const sections = parse_markdown(mdContent);
  const firstHeadingMatch = mdContent.match(/^#{1,6}\s+/m);
  const preamble = firstHeadingMatch
    ? mdContent.slice(0, mdContent.indexOf(firstHeadingMatch[0])).trim()
    : mdContent.trim();

  const root: Node = {
    id: '/',
    text: preamble,
    title: 'TEST',
    summary: 'root summary',
    level: 0,
    children: sections.map((s) => build_node(s, '/', 1)),
    links: [],
  };

  for (const node of collect_nodes_bottom_up(root)) {
    if (!node.summary) node.summary = 'stub summary';
  }

  return {
    dir: '/tmp/test',
    source_file: 'TEST.md',
    hash: oldHash,
    compiled_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    root,
  };
}

describe('incremental_compile hash persistence', () => {
  let tempDir: string;
  let mdPath: string;
  let outPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-incr-'));
    mdPath = path.join(tempDir, 'TEST.md');
    outPath = path.join(tempDir, 'mindmap.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should persist the correct hash to disk after incremental compile', async () => {
    const mdContent = `# Overview

Test project.

## Setup

Instructions.

### Prerequisites

Node.js.

## Architecture

Three layers.
`;
    fs.writeFileSync(mdPath, mdContent);

    const staleHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const mindmap = makeMinimalMindmap(mdContent, staleHash);
    save_mindmap_atomic(mindmap, outPath);

    const result = await incremental_compile(mdPath, mindmap, tempDir, outPath);

    const actualHash = compute_hash(mdContent);
    expect(result.hash).toBe(actualHash);
    expect(result.hash).not.toBe(staleHash);

    const saved = load_mindmap(outPath);
    expect(saved.hash).toBe(actualHash);
    expect(saved.hash).not.toBe(staleHash);

    const fileHash = compute_hash(fs.readFileSync(mdPath, 'utf-8'));
    expect(saved.hash).toBe(fileHash);
  });

  it('should persist hash even with no node changes', async () => {
    const mdContent = '# Only\n\nJust one section.';
    fs.writeFileSync(mdPath, mdContent);

    const staleHash = '1111111111111111111111111111111111111111111111111111111111111111';
    const mindmap = makeMinimalMindmap(mdContent, staleHash);
    save_mindmap_atomic(mindmap, outPath);

    const result = await incremental_compile(mdPath, mindmap, tempDir, outPath);

    const actualHash = compute_hash(mdContent);
    expect(result.hash).toBe(actualHash);

    const saved = load_mindmap(outPath);
    expect(saved.hash).toBe(actualHash);
  });

  it('should persist hash after propagation to ancestors', async () => {
    const newContent = `# Top

Top content.

## Middle

Middle content.

### Bottom

Changed bottom.
`;
    fs.writeFileSync(mdPath, newContent);

    const staleHash = '2222222222222222222222222222222222222222222222222222222222222222';
    const oldContent = `# Top

Top content.

## Middle

Middle content.

### Bottom

Original bottom.
`;
    const mindmap = makeMinimalMindmap(oldContent, staleHash);
    save_mindmap_atomic(mindmap, outPath);

    const result = await incremental_compile(mdPath, mindmap, tempDir, outPath);

    const actualHash = compute_hash(fs.readFileSync(mdPath, 'utf-8'));
    expect(result.hash).toBe(actualHash);

    const saved = load_mindmap(outPath);
    expect(saved.hash).toBe(actualHash);
  });

  it('should not crash when outPath is undefined', async () => {
    const mdContent = '# A\n\nSection A.';
    fs.writeFileSync(mdPath, mdContent);

    const staleHash = '3333333333333333333333333333333333333333333333333333333333333333';
    const mindmap = makeMinimalMindmap(mdContent, staleHash);

    const result = await incremental_compile(mdPath, mindmap, tempDir, undefined);

    expect(result.hash).toBe(compute_hash(mdContent));
  });

  it('should update updated_at in the persisted file', async () => {
    const mdContent = '# Main\n\nContent.';
    fs.writeFileSync(mdPath, mdContent);

    const staleHash = '4444444444444444444444444444444444444444444444444444444444444444';
    const mindmap = makeMinimalMindmap(mdContent, staleHash);
    save_mindmap_atomic(mindmap, outPath);

    const before = new Date();
    await incremental_compile(mdPath, mindmap, tempDir, outPath);

    const saved = load_mindmap(outPath);
    const savedTime = new Date(saved.updated_at);
    expect(savedTime.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });
});
