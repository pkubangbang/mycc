/**
 * mindmap.ts - ChildMindmap for child process (teammate)
 *
 * Each process maintains its own mindmap instance - NO IPC for mindmap operations.
 * The child loads its own copy from .mycc/mindmap.json independently.
 */

import * as path from 'path';
import * as fs from 'fs';
import type { MindmapModule, CoreModule } from '../../types.js';
import type { Mindmap, Node } from '../../mindmap/types.js';
import {
  compile_mindmap,
  load_mindmap,
  save_mindmap,
  get_node,
  patch_mindmap,
  validate_mindmap,
} from '../../mindmap/index.js';
import { get_default_mindmap_path } from '../../mindmap/load.js';

/**
 * ChildMindmap - Mindmap module for child process
 * Loads .mycc/mindmap.json independently (no IPC)
 */
export class ChildMindmap implements MindmapModule {
  private mindmap: Mindmap | null = null;
  private core: CoreModule;
  private mdPath: string | null = null;

  constructor(core: CoreModule) {
    this.core = core;
  }

  /**
   * Load mindmap from .mycc/mindmap.json
   */
  async load(): Promise<boolean> {
    const mindmapPath = get_default_mindmap_path(this.core.getWorkDir());
    
    if (!fs.existsSync(mindmapPath)) {
      this.core.brief('warn', 'mindmap', 'No mindmap found');
      return false;
    }

    try {
      this.mindmap = load_mindmap(mindmapPath);
      this.core.brief('info', 'mindmap', `Loaded mindmap with ${this.countNodes(this.mindmap.root)} nodes`);
      return true;
    } catch (err) {
      this.core.brief('error', 'mindmap', `Failed to load: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Get current mindmap
   */
  getMindmap(): Mindmap | null {
    return this.mindmap;
  }

  /**
   * Get node by path
   */
  getNode(nodePath: string): Node | null {
    if (!this.mindmap) {
      return null;
    }
    return get_node(this.mindmap, nodePath);
  }

  /**
   * Compile markdown file to mindmap JSON
   */
  async compile(mdPath: string, cwd?: string): Promise<Mindmap> {
    const workDir = cwd || this.core.getWorkDir();
    
    this.core.brief('info', 'mindmap', `Compiling ${mdPath}...`);
    
    this.mindmap = await compile_mindmap(mdPath, workDir);
    this.mdPath = path.resolve(workDir, mdPath);
    
    save_mindmap(this.mindmap, undefined, workDir);
    
    this.core.brief('info', 'mindmap', `Compiled ${this.countNodes(this.mindmap.root)} nodes`);
    return this.mindmap;
  }

  /**
   * Patch a node's text and update summaries
   */
  async patch(nodePath: string, newText: string, feedback?: string): Promise<Node | null> {
    if (!this.mindmap) {
      throw new Error('No mindmap loaded');
    }

    const node = get_node(this.mindmap, nodePath);
    if (!node) {
      return null;
    }

    this.core.brief('info', 'mindmap', `Patching node ${nodePath}...`);

    const updatedNode = patch_mindmap(this.mindmap, nodePath, newText, feedback);
    save_mindmap(this.mindmap);

    return updatedNode;
  }

  /**
   * Validate mindmap
   */
  async validate(): Promise<boolean> {
    if (!this.mindmap) {
      this.core.brief('warn', 'mindmap', 'No mindmap loaded');
      return false;
    }

    if (!this.mdPath || !fs.existsSync(this.mdPath)) {
      this.core.brief('warn', 'mindmap', 'Source markdown not tracked');
      return false;
    }

    const valid = validate_mindmap(this.mindmap, this.mdPath);
    
    if (valid) {
      this.core.brief('info', 'mindmap', 'Mindmap is valid');
      return true;
    } else {
      this.core.brief('warn', 'mindmap', 'Validation failed');
      return false;
    }
  }

  /**
   * Save mindmap to disk
   */
  async save(): Promise<void> {
    if (!this.mindmap) {
      throw new Error('No mindmap to save');
    }
    
    save_mindmap(this.mindmap);
    this.core.brief('info', 'mindmap', 'Mindmap saved');
  }

  private countNodes(node: Node): number {
    let count = 1;
    for (const child of node.children) {
      count += this.countNodes(child);
    }
    return count;
  }
}
