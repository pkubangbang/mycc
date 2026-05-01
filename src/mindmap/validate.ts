/**
 * validate.ts - Mindmap validation utilities
 * @see docs/mindmap-design.md
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { MindmapJSON } from './types.js';

/**
 * Compute hash of file content
 * @param filePath - Path to the file
 * @param algorithm - Hash algorithm (default: sha256)
 * @returns Hex-encoded hash string
 */
export function compute_file_hash(filePath: string, algorithm: string = 'sha256'): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return compute_hash(content, algorithm);
}

/**
 * Compute hash of string content
 * @param content - String content to hash
 * @param algorithm - Hash algorithm (default: sha256)
 * @returns Hex-encoded hash string
 */
export function compute_hash(content: string, algorithm: string = 'sha256'): string {
  return crypto.createHash(algorithm).update(content).digest('hex');
}

/**
 * Validate that a JSON mindmap matches the markdown file
 * @param json - The parsed mindmap JSON
 * @param mdPath - Path to the markdown file (absolute or relative to json.dir)
 * @returns true if hashes match, false otherwise
 */
export function validate_mindmap(json: MindmapJSON, mdPath: string): boolean {
  try {
    // Resolve the markdown path if relative
    let resolvedPath = mdPath;
    if (!path.isAbsolute(mdPath) && json.dir) {
      resolvedPath = path.join(json.dir, mdPath);
    }
    
    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return false;
    }
    
    // Compute hash of the markdown file
    const hash = compute_file_hash(resolvedPath);
    
    // Compare with stored hash
    return hash === json.hash;
  } catch {
    return false;
  }
}

/**
 * Validate mindmap JSON structure
 * @param json - The parsed JSON to validate
 * @returns true if structure is valid, false otherwise
 */
export function validate_mindmap_structure(json: unknown): json is MindmapJSON {
  if (typeof json !== 'object' || json === null) {
    return false;
  }
  
  const obj = json as Record<string, unknown>;
  
  // Check required top-level fields
  if (typeof obj.dir !== 'string') return false;
  if (typeof obj.hash !== 'string') return false;
  if (typeof obj.compiled_at !== 'string') return false;
  if (typeof obj.updated_at !== 'string') return false;
  
  // Validate root node
  if (!validate_node_structure(obj.root)) return false;
  
  return true;
}

/**
 * Validate a node structure recursively
 * @param node - The node to validate
 * @returns true if valid, false otherwise
 */
function validate_node_structure(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  
  const obj = node as Record<string, unknown>;
  
  // Check required node fields
  if (typeof obj.id !== 'string') return false;
  if (typeof obj.text !== 'string') return false;
  if (typeof obj.title !== 'string') return false;
  if (typeof obj.summary !== 'string') return false;
  if (typeof obj.level !== 'number') return false;
  if (!Array.isArray(obj.children)) return false;
  if (!Array.isArray(obj.links)) return false;
  
  // Validate children recursively
  for (const child of obj.children) {
    if (!validate_node_structure(child)) return false;
  }
  
  // Validate links
  for (const link of obj.links) {
    if (!validate_link_structure(link)) return false;
  }
  
  return true;
}

/**
 * Validate a link structure
 * @param link - The link to validate
 * @returns true if valid, false otherwise
 */
function validate_link_structure(link: unknown): boolean {
  if (typeof link !== 'object' || link === null) {
    return false;
  }
  
  const obj = link as Record<string, unknown>;
  
  // Check required fields
  if (obj.target_type !== 'node' && obj.target_type !== 'file' && obj.target_type !== 'url') {
    return false;
  }
  
  if (typeof obj.comment !== 'string') return false;
  
  // Check target-specific fields
  if (obj.target_type === 'node' && typeof obj.node_id !== 'string') return false;
  if (obj.target_type === 'file' && typeof obj.file_path !== 'string') return false;
  if (obj.target_type === 'url' && typeof obj.url !== 'string') return false;
  
  return true;
}

/**
 * Parse and validate a mindmap JSON file
 * @param jsonPath - Path to the JSON file
 * @returns Parsed and validated MindmapJSON, or null if invalid
 */
export function parse_mindmap_json(jsonPath: string): MindmapJSON | null {
  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    
    if (!validate_mindmap_structure(parsed)) {
      return null;
    }
    
    return parsed;
  } catch {
    return null;
  }
}
