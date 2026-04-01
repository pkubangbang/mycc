/**
 * issue.ts - ChildIssue implementation for IPC-based issue operations
 */

import type { IssueModule, Issue, IssueComment } from '../../types.js';
import { ipc } from './ipc-helpers.js';

/**
 * Issue module for child process
 * All operations go through IPC to parent
 */
export class ChildIssue implements IssueModule {
  async createIssue(title: string, content: string, blockedBy: number[] = []): Promise<number> {
    const result = await ipc.sendRequest<{ id: number }>('db_issue_create', {
      title,
      content,
      blockedBy,
    });
    return result.id;
  }

  async getIssue(id: number): Promise<Issue | undefined> {
    const result = await ipc.sendRequest<Issue | undefined>('db_issue_get', { id });
    return result;
  }

  async listIssues(): Promise<Issue[]> {
    const result = await ipc.sendRequest<Issue[]>('db_issue_list', {});
    return result;
  }

  async printIssues(): Promise<string> {
    const issues = await this.listIssues();
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

  async printIssue(id: number): Promise<string> {
    const issue = await this.getIssue(id);
    if (!issue) {
      return `Issue #${id} not found.`;
    }

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

  async claimIssue(id: number, owner: string): Promise<boolean> {
    const result = await ipc.sendRequest<{ claimed: boolean }>('db_issue_claim', {
      id,
      owner,
    });
    return result.claimed;
  }

  async closeIssue(
    id: number,
    status: 'completed' | 'failed' | 'abandoned',
    comment?: string,
    poster?: string
  ): Promise<void> {
    await ipc.sendRequest<void>('db_issue_close', { id, status, comment, poster });
  }

  async addComment(id: number, comment: string, poster?: string): Promise<void> {
    await ipc.sendRequest<void>('db_issue_comment', { id, comment, poster });
  }

  async createBlockage(blocker: number, blocked: number): Promise<void> {
    await ipc.sendRequest<void>('db_block_add', { blocker, blocked });
  }

  async removeBlockage(blocker: number, blocked: number): Promise<void> {
    await ipc.sendRequest<void>('db_block_remove', { blocker, blocked });
  }
}

/**
 * Create a child issue module
 */
export function createChildIssue(): IssueModule {
  return new ChildIssue();
}