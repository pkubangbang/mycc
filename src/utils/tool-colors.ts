/**
 * tool-colors.ts - Color mapping for tool prefixes in brief() output
 *
 * This module provides consistent coloring for tool names across the application.
 * Used by core.brief() to visually distinguish different tools in the terminal.
 *
 * Color scheme — grouped by functional category, each category uses ONE
 * consistent color so related tools are visually coherent and easy to
 * identify. Every label passed to brief() has an explicit entry; labels
 * not found here fall back to _default (white) so missing mappings are
 * visible. Add new labels to their category, not as a bare _default.
 */

import chalk from 'chalk';

/**
 * Color functions for tool prefixes
 * Each function takes a string and returns it colored with chalk
 *
 * Category colors (16 chalk colors, 18 categories — a few distant
 * categories intentionally share a color; collisions are between unrelated
 * subsystems unlikely to appear adjacently):
 *   cyan        - Shell/Execution, Interactive
 *   green       - File Read
 *   greenBright - Image/Vision, Git
 *   blue        - File Write
 *   magenta     - File Edit, Interactive, Plan/Mode
 *   cyanBright  - Search/Web, Team/Comm
 *   blueBright  - Knowledge/Wiki
 *   magentaBright - Skills
 *   yellow      - Issues
 *   yellowBright- Todos
 *   gray         - Background, Hooks, System/Internal
 *   white        - Brief, Default
 */
const TOOL_COLORS: Record<string, (text: string) => string> = {
  // Shell / Execution
  bash: chalk.cyan,
  bash_display: chalk.cyan,

  // File Read
  read: chalk.green,
  read_file: chalk.green,
  read_read: chalk.green,

  // Image / Vision
  read_picture: chalk.greenBright,
  read_picture_cached: chalk.greenBright,
  screen: chalk.greenBright,
  img_describe: chalk.greenBright,

  // File Write
  write: chalk.blue,
  write_file: chalk.blue,

  // File Edit
  edit: chalk.magenta,
  edit_file: chalk.magenta,

  // Search / Web
  grep: chalk.cyanBright,
  web_search: chalk.cyanBright,
  web_fetch: chalk.cyanBright,

  // Knowledge / Wiki
  recall: chalk.blueBright,
  wiki: chalk.blueBright,
  wiki_get: chalk.blueBright,
  wiki_prepare: chalk.blueBright,
  wiki_put: chalk.blueBright,

  // Skills
  skill_load: chalk.magentaBright,
  skill_search: chalk.magentaBright,
  skill_compile: chalk.magentaBright,

  // Issues
  issue_create: chalk.yellow,
  issue_close: chalk.yellow,
  issue_claim: chalk.yellow,
  issue_comment: chalk.yellow,
  issue_publish: chalk.yellow,
  issue_list: chalk.yellow,
  blockage_create: chalk.yellow,
  blockage_remove: chalk.yellow,

  // Todos
  todo_create: chalk.yellowBright,
  todo_update: chalk.yellowBright,
  todo_pinning: chalk.yellowBright,

  // Team / Communication
  tm_create: chalk.cyanBright,
  tm_remove: chalk.cyanBright,
  tm_await: chalk.cyanBright,
  tm_print: chalk.cyanBright,
  mail_to: chalk.cyanBright,
  broadcast: chalk.cyanBright,
  peers: chalk.cyanBright,

  // Background tasks
  bg: chalk.gray,
  bg_create: chalk.gray,
  bg_print: chalk.gray,
  bg_remove: chalk.gray,
  bg_await: chalk.gray,

  // Git
  git_commit: chalk.greenBright,

  // Interactive
  hand_over: chalk.magenta,
  question: chalk.magenta,

  // Brief (agent self-status)
  brief: chalk.white,

  // Plan / Mode
  plan_on: chalk.magenta,
  plan_off: chalk.magenta,
  mode_change: chalk.magenta,

  // Hooks
  hook: chalk.gray,

  // System / Internal
  loop: chalk.gray,
  idle: chalk.gray,
  worker: chalk.gray,
  session: chalk.gray,
  assistant: chalk.gray,
  auto_claim: chalk.gray,
  awaitTeam: chalk.gray,
  watchdog: chalk.gray,
  compact: chalk.gray,
  loader: chalk.gray,
  explorer: chalk.gray,
  tp: chalk.gray,
  triologue: chalk.gray,
  autoCompact: chalk.gray,
  eta_update: chalk.gray,
  config: chalk.gray,
  checkpoint: chalk.gray,
  recap: chalk.gray,
  crossroad: chalk.gray,
  stop: chalk.gray,
  tool: chalk.gray,
  'mindmap-patch': chalk.gray,
  eval: chalk.gray,

  // Default fallback
  _default: chalk.white,
};

/**
 * Get the color function for a tool name
 * Falls back to _default if tool not found
 */
export function getToolColor(tool: string): (text: string) => string {
  return TOOL_COLORS[tool] || TOOL_COLORS._default;
}