/**
 * registry.ts - Built-in tool definitions registry
 *
 * Central registry of all built-in tools for the mycc agent.
 * Imported by loader.ts and potentially other modules that need
 * access to the tool definitions.
 */

import type { ToolDefinition } from '../../types.js';
import { bashTool } from '../../tools/bash.js';
import { readTool } from '../../tools/read.js';
import { writeTool } from '../../tools/write.js';
import { editTool } from '../../tools/edit.js';
import { todoCreateTool } from '../../tools/todo_create.js';
import { todoUpdateTool } from '../../tools/todo_update.js';
import { todoPinningTool } from '../../tools/todo_pinning.js';
import { skillLoadTool } from '../../tools/skill_load.js';
import { tmCreateTool } from '../../tools/tm_create.js';
import { tmRemoveTool } from '../../tools/tm_remove.js';
import { tmAwaitTool } from '../../tools/tm_await.js';
import { tmPrintTool } from '../../tools/tm_print.js';
import { mailToTool } from '../../tools/mail_to.js';
import { myccTitleTool } from '../../tools/mycc_title.js';
import { broadcastTool } from '../../tools/broadcast.js';
import { questionTool } from '../../tools/question.js';
import { briefTool } from '../../tools/brief.js';
import { issueCreateTool } from '../../tools/issue_create.js';
import { issueCloseTool } from '../../tools/issue_close.js';
import { issueCommentTool } from '../../tools/issue_comment.js';
import { issueClaimTool } from '../../tools/issue_claim.js';
import { issuePublishTool } from '../../tools/issue_publish.js';
import { issueListTool } from '../../tools/issue_list.js';
import { blockageCreateTool } from '../../tools/blockage_create.js';
import { blockageRemoveTool } from '../../tools/blockage_remove.js';
import { webFetchTool } from '../../tools/web_fetch.js';
import { webSearchTool } from '../../tools/web_search.js';
import { bgCreateTool } from '../../tools/bg_create.js';
import { bgPrintTool } from '../../tools/bg_print.js';
import { bgRemoveTool } from '../../tools/bg_remove.js';
import { bgAwaitTool } from '../../tools/bg_await.js';
import { screenTool } from '../../tools/screen.js';
import { readReadTool } from '../../tools/read-read.js';
import { readPictureTool } from '../../tools/read-picture.js';
import { wikiPrepareTool } from '../../tools/wiki_prepare.js';
import { wikiPutTool } from '../../tools/wiki_put.js';
import { wikiGetTool } from '../../tools/wiki_get.js';
import { orderTool } from '../../tools/order.js';
import { handOverTool } from '../../tools/hand_over.js';
import { gitCommitTool } from '../../tools/git_commit.js';
import { grepTool } from '../../tools/grep.js';
import { skillCompileTool } from '../../tools/skill_compile.js';
import { skillSearchTool } from '../../tools/skill_search.js';
import { planOnTool } from '../../tools/plan_on.js';
import { recallTool } from '../../tools/recall.js';
import { planOffTool } from '../../tools/plan_off.js';
import { checkpointTool } from '../../tools/checkpoint.js';
import { recapTool } from '../../tools/recap.js';

/**
 * Built-in tool definitions array.
 * These tools are always loaded and cannot be overridden by user or project tools.
 */
export const builtInTools: ToolDefinition[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  todoCreateTool,
  todoUpdateTool,
  todoPinningTool,
  skillLoadTool,
  tmCreateTool,
  tmRemoveTool,
  tmAwaitTool,
  tmPrintTool,
  mailToTool,
  myccTitleTool,
  broadcastTool,
  questionTool,
  briefTool,
  issueCreateTool,
  issueCloseTool,
  issueCommentTool,
  issueClaimTool,
  issuePublishTool,
  issueListTool,
  blockageCreateTool,
  blockageRemoveTool,
  webFetchTool,
  webSearchTool,
  bgCreateTool,
  bgPrintTool,
  bgRemoveTool,
  bgAwaitTool,
  screenTool,
  readPictureTool,
  readReadTool,
  wikiPrepareTool,
  wikiPutTool,
  wikiGetTool,
  orderTool,
  handOverTool,
  gitCommitTool,
  grepTool,
  skillCompileTool,
  skillSearchTool,
  planOnTool,
  planOffTool,
  recallTool,
  checkpointTool,
  recapTool,
];