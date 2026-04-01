/**
 * issue.ts - ChildIssue implementation for IPC-based issue operations
 */

import type { IssueModule, Issue, IssueStatus } from '../../types.js';
import { sendRequest } from './ipc-helpers.js';

/**
 * Issue module for child process
 * All operations go through IPC to parent
 */
export class ChildIssue implements IssueModule {
  async createIssue(title: string, content: string, blockedBy: number[] = []): Promise<number> {
    const result = await sendRequest<{ id: number }>('db_issue_create', {
      title,
      content,
      blockedBy,
    });
    return result.id;
  }

  async getIssue(id: number): Promise<Issue | undefined> {
    const result = await sendRequest<Issue | undefined>('db_issue_get', { id });
    return result;
  }

  async listIssues(): Promise<Issue[]> {
    const result = await sendRequest<Issue[]>('db_issue_list', {});
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

  async claimIssue(id: number, owner: string): Promise<boolean> {
    const result = await sendRequest<{ claimed: boolean }>('db_issue_claim', {
      id,
      owner,
    });
    return result.claimed;
  }

  async closeIssue(
    id: number,
    status: 'completed' | 'failed' | 'abandoned',
    comment?: string
  ): Promise<void> {
    await sendRequest<void>('db_issue_close', { id, status, comment });
  }

  async addComment(id: number, comment: string): Promise<void> {
    await sendRequest<void>('db_issue_comment', { id, comment });
  }

  async createBlockage(blocker: number, blocked: number): Promise<void> {
    await sendRequest<void>('db_block_add', { blocker, blocked });
  }

  async removeBlockage(blocker: number, blocked: number): Promise<void> {
    await sendRequest<void>('db_block_remove', { blocker, blocked });
  }
}

/**
 * Create a child issue module
 */
export function createChildIssue(): IssueModule {
  return new ChildIssue();
}