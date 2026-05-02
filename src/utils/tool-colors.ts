/**
 * tool-colors.ts - Color mapping for tool prefixes in brief() output
 *
 * This module provides consistent coloring for tool names across the application.
 * Used by core.brief() to visually distinguish different tools in the terminal.
 */

import chalk from 'chalk';

/**
 * Color functions for tool prefixes
 * Each function takes a string and returns it colored with chalk
 */
export const TOOL_COLORS: Record<string, (text: string) => string> = {
  // File operations
  bash: chalk.cyan,
  read: chalk.green,
  read_file: chalk.green,
  read_picture: chalk.greenBright,
  read_read: chalk.greenBright,
  write: chalk.blue,
  write_file: chalk.blue,
  edit: chalk.magenta,
  edit_file: chalk.magenta,

  // Web operations
  web_fetch: chalk.cyanBright,
  web_search: chalk.cyanBright,

  // Knowledge & Skills
  recall: chalk.magentaBright,
  wiki: chalk.blueBright,
  skill_load: chalk.cyanBright,
  skill_compile: chalk.cyan,

  // Task management
  issue_create: chalk.yellow,
  issue_close: chalk.yellow,
  issue_claim: chalk.yellow,
  issue_comment: chalk.yellow,
  issue_list: chalk.yellow,
  blockage_create: chalk.yellow,
  blockage_remove: chalk.yellow,
  todo_write: chalk.yellow,

  // Team management
  tm_create: chalk.magentaBright,
  tm_remove: chalk.redBright,
  tm_await: chalk.blueBright,
  tm_print: chalk.blueBright,
  mail_to: chalk.cyanBright,
  broadcast: chalk.cyanBright,
  order: chalk.blueBright,

  // Background tasks
  bg: chalk.gray,
  bg_create: chalk.gray,
  bg_print: chalk.gray,
  bg_remove: chalk.red,
  bg_await: chalk.blue,

  // Git & Worktrees
  git_commit: chalk.greenBright,
  wt_create: chalk.cyan,
  wt_enter: chalk.cyan,
  wt_leave: chalk.cyan,
  wt_print: chalk.cyan,
  wt_remove: chalk.red,

  // Screen & Vision
  screen: chalk.greenBright,

  // Interactive
  hand_over: chalk.magentaBright,
  question: chalk.cyanBright,
  brief: chalk.white,

  // Mode
  plan_on: chalk.magenta,
  plan_off: chalk.magenta,
  mode_change: chalk.magenta,

  // Hooks
  hook: chalk.cyanBright,

  // System/Internal
  loop: chalk.gray,
  idle: chalk.gray,
  worker: chalk.gray,
  session: chalk.gray,
  assistant: chalk.gray,
  auto_claim: chalk.gray,
  awaitTeam: chalk.red,

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