/**
 * load.ts - Load mindmap from JSON
 * @see docs/mindmap-design.md
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Mindmap, MindmapJSON, Node } from './types.js';
import { validate_mindmap_structure } from './validate.js';

/**
 * Load a mindmap from a JSON file
 * @param jsonPath - Path to the JSON file
 * @returns Loaded Mindmap instance
 * @throws Error if file not found or invalid structure
 */
export function load_mindmap(jsonPath: string): Mindmap {
  const absolutePath = path.resolve(jsonPath);
  
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Mindmap JSON not found: ${absolutePath}`);
  }
  
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const parsed: unknown = JSON.parse(content);
  
  return load_mindmap_from_json(parsed);
}

/**
 * Load a mindmap from parsed JSON
 * @param json - Parsed JSON object
 * @returns Loaded Mindmap instance
 * @throws Error if invalid structure
 */
export function load_mindmap_from_json(json: unknown): Mindmap {
  if (!validate_mindmap_structure(json)) {
    throw new Error('Invalid mindmap JSON structure');
  }

  const mindmapJson = json as MindmapJSON;

  // Set in-memory flags on every node: is_mycc=true (from mindmap.json = MYCC.md
  // isomorph), is_patch=false (unmodified until patches are replayed).
  // These flags are never serialized — they exist only in the in-memory model.
  set_in_memory_flags(mindmapJson.root);

  // Return mindmap with all fields
  return {
    dir: mindmapJson.dir,
    source_file: mindmapJson.source_file,
    hash: mindmapJson.hash,
    compiled_at: mindmapJson.compiled_at,
    updated_at: mindmapJson.updated_at,
    root: mindmapJson.root,
  };
}

/**
 * Set in-memory flags (is_mycc=true, is_patch=false) recursively on all nodes.
 * Called when loading nodes from mindmap.json — they are by definition MYCC.md-sourced.
 * Patches replayed later will flip is_patch and/or set is_mycc=false on added nodes.
 */
function set_in_memory_flags(node: Node): void {
  node.is_mycc = true;
  node.is_patch = false;
  for (const child of node.children) {
    set_in_memory_flags(child);
  }
}

/**
 * Get the default mindmap path for a project
 * @param projectDir - The project directory (default: current working directory)
 * @returns Path to .mycc/mindmap.json
 */
export function get_default_mindmap_path(projectDir?: string): string {
  const baseDir = projectDir || process.cwd();
  return path.join(baseDir, '.mycc', 'mindmap.json');
}

/**
 * Check if a mindmap exists at the default location
 * @param projectDir - The project directory
 * @returns true if mindmap.json exists
 */
export function mindmap_exists(projectDir?: string): boolean {
  const mindmapPath = get_default_mindmap_path(projectDir);
  return fs.existsSync(mindmapPath);
}

/**
 * Try to load mindmap, return null if not found or invalid
 * @param jsonPath - Path to JSON file (optional, uses default if not provided)
 * @param projectDir - Project directory for default path
 * @returns Mindmap or null
 */
export function try_load_mindmap(jsonPath?: string, projectDir?: string): Mindmap | null {
  try {
    const path = jsonPath || get_default_mindmap_path(projectDir);
    return load_mindmap(path);
  } catch {
    return null;
  }
}

/**
 * Save a mindmap to JSON file
 * @param mindmap - The mindmap to save
 * @param jsonPath - Output path (optional, uses default if not provided)
 * @param projectDir - Project directory for default path
 */
export function save_mindmap(mindmap: Mindmap, jsonPath?: string, projectDir?: string): void {
  const outputPath = jsonPath || get_default_mindmap_path(projectDir);
  const dir = path.dirname(outputPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Strip in-memory flags before serialization (is_mycc/is_patch are not in JSON)
  const root = strip_in_memory_flags(mindmap.root);

  const json: MindmapJSON = {
    dir: mindmap.dir,
    source_file: mindmap.source_file,
    hash: mindmap.hash,
    compiled_at: mindmap.compiled_at,
    updated_at: mindmap.updated_at,
    root,
  };

  fs.writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf-8');
}

/**
 * Serialize mindmap to JSON string
 * @param mindmap - The mindmap to serialize
 * @returns JSON string
 */
export function serialize_mindmap(mindmap: Mindmap): string {
  // Strip in-memory flags before serialization (is_mycc/is_patch are not in JSON)
  const root = strip_in_memory_flags(mindmap.root);

  const json: MindmapJSON = {
    dir: mindmap.dir,
    source_file: mindmap.source_file,
    hash: mindmap.hash,
    compiled_at: mindmap.compiled_at,
    updated_at: mindmap.updated_at,
    root,
  };

  return JSON.stringify(json, null, 2);
}

/**
 * Deep-clone a node tree with in-memory flags (is_mycc/is_patch) removed.
 * Ensures these runtime-only flags never leak into mindmap.json on disk.
 */
function strip_in_memory_flags(node: Node): Node {
  return {
    id: node.id,
    text: node.text,
    title: node.title,
    summary: node.summary,
    level: node.level,
    children: node.children.map((c) => strip_in_memory_flags(c)),
    links: node.links,
  };
}
