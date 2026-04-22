/**
 * issue.ts - Issue module: in-memory tasks with blocking relationships
 */

import type { IssueModule, Issue } from '../types.js';
import * as MemoryStore from './memory-store.js';

/**
 * Issue module implementation using in-memory storage
 */
export class IssueManager implements IssueModule {
  /**
   * Create a new issue
   */
  async createIssue(title: string, content: string, blockedBy: number[] = []): Promise<number> {
    return MemoryStore.createIssue(title, content, blockedBy);
  }

  /**
   * Get an issue by ID
   */
  async getIssue(id: number): Promise<Issue | undefined> {
    return MemoryStore.getIssue(id);
  }

  /**
   * List all issues
   */
  async listIssues(): Promise<Issue[]> {
    return MemoryStore.listIssues();
  }

  /**
   * Format issues for prompt
   */
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
      const blockedBy = issue.blockedBy.length > 0 ? ` blocked:${issue.blockedBy.join(',')}` : '';
      lines.push(`  ${marker} #${issue.id}: ${issue.title}${owner}${blockedBy}`);
    }
    return lines.join('\n');
  }

  /**
   * Format a single issue for display
   */
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

  /**
   * Claim an issue (atomic operation)
   */
  async claimIssue(id: number, owner: string): Promise<boolean> {
    const issue = MemoryStore.getIssue(id);
    if (!issue || issue.status !== 'pending') {
      return false;
    }

    // Update status and owner
    MemoryStore.updateIssue(id, { status: 'in_progress', owner });
    MemoryStore.addIssueComment(id, `Claimed by @${owner}`, 'system');
    return true;
  }

  /**
   * Close an issue
   */
  async closeIssue(
    id: number,
    status: 'completed' | 'failed' | 'abandoned',
    comment?: string,
    poster?: string
  ): Promise<void> {
    const issue = MemoryStore.getIssue(id);
    if (!issue) return;

    // Update status
    MemoryStore.updateIssue(id, { status });
    MemoryStore.addIssueComment(id, `Status changed to ${status}`, 'system');

    // Add closing comment if provided
    if (comment) {
      MemoryStore.addIssueComment(id, comment, poster || issue.owner || 'anonymous');
    }

    // Remove any blockages where this issue is the blocker
    for (const blockedId of issue.blocks) {
      MemoryStore.removeBlockage(id, blockedId);
    }
  }

  /**
   * Add a comment to an issue
   */
  async addComment(id: number, comment: string, poster?: string): Promise<void> {
    MemoryStore.addIssueComment(id, comment, poster || 'anonymous');
  }

  /**
   * Create a blockage relationship
   */
  async createBlockage(blocker: number, blocked: number): Promise<void> {
    MemoryStore.createBlockage(blocker, blocked);
  }

  /**
   * Remove a blockage relationship
   */
  async removeBlockage(blocker: number, blocked: number): Promise<void> {
    MemoryStore.removeBlockage(blocker, blocked);
  }
}