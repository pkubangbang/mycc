/**
 * issue.ts - ChildIssue implementation for IPC-based issue operations
 */

import type { IssueModule, Issue } from '../../types.js';
import { ipc } from './ipc-helpers.js';
import { formatIssueList, formatIssueDetail } from '../shared/format-issue.js';

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
    return formatIssueList(issues);
  }

  async printIssue(id: number): Promise<string> {
    const issue = await this.getIssue(id);
    if (!issue) {
      return `Issue #${id} not found.`;
    }
    return formatIssueDetail(issue);
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
