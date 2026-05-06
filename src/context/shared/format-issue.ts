/**
 * format-issue.ts - Shared issue formatting utilities
 *
 * Extracted from IssueManager and ChildIssue to avoid duplication.
 * Both parent and child contexts use identical formatting logic.
 */

import type { Issue } from '../../types.js';

/**
 * Format a list of issues for display
 * @param issues - Array of issues to format
 * @returns Formatted string for prompt output
 */
export function formatIssueList(issues: Issue[]): string {
  if (issues.length === 0) {
    return 'No issues.';
  }

  const lines = ['Issues:'];
  for (const issue of issues) {
    const status: Record<string, string> = {
      pending: '[ ]',
      in_progress: '[>]',
      completed: '[x]',
      failed: '[!]',
      abandoned: '[-]',
    };
    const marker = status[issue.status] || '[?]';
    const owner = issue.owner ? ` @${issue.owner}` : '';
    const blockedBy =
      issue.blockedBy.length > 0 ? ` blocked:${issue.blockedBy.join(',')}` : '';
    lines.push(`  ${marker} #${issue.id}: ${issue.title}${owner}${blockedBy}`);
  }
  return lines.join('\n');
}

/**
 * Format a single issue for detailed display
 * @param issue - The issue to format
 * @returns Formatted string for prompt output
 */
export function formatIssueDetail(issue: Issue): string {
  const status: Record<string, string> = {
    pending: '[ ]',
    in_progress: '[>]',
    completed: '[x]',
    failed: '[!]',
    abandoned: '[-]',
  };

  const lines: string[] = [];
  lines.push(`Issue #${issue.id}: ${issue.title}`);
  lines.push(`Status: ${status[issue.status] || '[?]'}`);
  if (issue.owner) lines.push(`Owner: @${issue.owner}`);
  if (issue.content) lines.push('Content:', `${issue.content}`);
  if (issue.blockedBy.length > 0) lines.push(`Blocked by: ${issue.blockedBy.join(', ')}`);
  if (issue.blocks.length > 0) lines.push(`Blocks: ${issue.blocks.join(', ')}`);

  if (issue.comments.length > 0) {
    lines.push('Comments:');
    for (const comment of issue.comments) {
      // Owner's comments have "<" prefix (input), others have ">" prefix (output)
      const isOwner = comment.poster === issue.owner;
      const prefix = isOwner ? '<' : '>';
      const posterLabel = comment.poster === 'system' ? 'system' : `@${comment.poster}`;
      lines.push(`  ${prefix} ${posterLabel}: ${comment.content}`);
    }
  }

  return lines.join('\n');
}
