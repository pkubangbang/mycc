/**
 * Mindmap Module - Public API
 * 
 * A mindmap is a tree structure of knowledge compiled from markdown files.
 * It serves as a persistent memory for the LLM agent.
 * 
 * Key features:
 * - Process isolation: Each process has its own mindmap instance
 * - No IPC required: File-based loading
 * - A-N-C-E summarization for node summaries
 * - Links are stubs (stored but not resolved)
 * 
 * @see docs/mindmap-design.md
 */

// Types
export type {
  Node,
  Mindmap,
  Link,
  MarkdownSection,
  ANCEContext,
  CompileOptions,
  PatchOptions,
  GetNodeResult,
  HashResult,
  MindmapJSON
} from './types.js';

// Core functions
export { get_node, get_node_result, get_ancestors, get_descendants, get_descendants_at_depth } from './get-node.js';
export { 
  compute_file_hash, 
  compute_hash, 
  validate_mindmap, 
  validate_mindmap_structure, 
  parse_mindmap_json 
} from './validate.js';
export { 
  load_mindmap, 
  load_mindmap_from_json,
  get_default_mindmap_path, 
  mindmap_exists, 
  try_load_mindmap,
  save_mindmap, 
  serialize_mindmap
} from './load.js';
export { parse_markdown, get_bottom_up_nodes, compile_mindmap, compile_mindmap_from_content } from './compile.js';
export { exploreAndSummarize, summarizeWithExplorer } from './explorer-agent.js';
export type { ExplorationResult } from './explorer-agent.js';
export { patch_mindmap, summarize_node, add_child_node, remove_node, move_node } from './patch.js';