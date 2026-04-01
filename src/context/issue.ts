/**
 * issue.ts - Issue module: persisted tasks with blocking relationships
 */

import type { IssueModule, Issue, IssueComment, IssueStatus, IpcHandlerRegistration, AgentContext } from '../types.js';
import { getDb } from './db.js';

/**
 * Issue module implementation using SQLite
 */
export class IssueManager implements IssueModule {
  /**
   * Create a new issue
   */
  async createIssue(title: string, content: string, blockedBy: number[] = []): Promise<number> {
    const db = getDb();

    // Create issue with initial system comment
    const initialComment: IssueComment = {
      poster: 'system',
      content: `Created issue "${title}"`,
      timestamp: new Date(),
    };
    const comments = JSON.stringify([initialComment]);

    const stmt = db.prepare(`
      INSERT INTO issues (title, content, status, owner, comments)
      VALUES (?, ?, 'pending', NULL, ?)
    `);

    const result = stmt.run(title, content, comments);
    const issueId = result.lastInsertRowid as number;

    // Create blockages
    for (const blockerId of blockedBy) {
      await this.createBlockage(blockerId, issueId);
    }

    return issueId;
  }

  /**
   * Get an issue by ID
   */
  async getIssue(id: number): Promise<Issue | undefined> {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT id, title, content, status, owner, created_at, comments
      FROM issues
      WHERE id = ?
    `);

    const row = stmt.get(id) as {
      id: number;
      title: string;
      content: string;
      status: string;
      owner: string | null;
      created_at: string;
      comments: string;
    } | undefined;

    if (!row) return undefined;

    return this.rowToIssue(row);
  }

  /**
   * List all issues
   */
  async listIssues(): Promise<Issue[]> {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT id, title, content, status, owner, created_at, comments
      FROM issues
      ORDER BY id
    `);

    const rows = stmt.all() as Array<{
      id: number;
      title: string;
      content: string;
      status: string;
      owner: string | null;
      created_at: string;
      comments: string;
    }>;

    return rows.map((row) => this.rowToIssue(row));
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
    const db = getDb();

    // Use transaction for atomicity
    const claimTx = db.transaction(() => {
      // Check if issue exists and is pending
      const stmt = db.prepare(`
        SELECT status FROM issues WHERE id = ?
      `);
      const row = stmt.get(id) as { status: string } | undefined;

      if (!row || row.status !== 'pending') {
        return false;
      }

      // Claim the issue
      const updateStmt = db.prepare(`
        UPDATE issues SET status = 'in_progress', owner = ?
        WHERE id = ? AND status = 'pending'
      `);
      const result = updateStmt.run(owner, id);

      if (result.changes > 0) {
        // Add system comment for claim
        this.addCommentSync(id, `Claimed by @${owner}`, 'system');
        return true;
      }
      return false;
    });

    return claimTx();
  }

  /**
   * Close an issue
   */
  async closeIssue(id: number, status: 'completed' | 'failed' | 'abandoned', comment?: string, poster?: string): Promise<void> {
    const db = getDb();

    const closeTx = db.transaction(() => {
      // Get current owner for system comment
      const issueRow = db.prepare(`SELECT owner FROM issues WHERE id = ?`).get(id) as { owner: string | null } | undefined;
      const owner = issueRow?.owner || 'unknown';

      // Update status
      const updateStmt = db.prepare(`
        UPDATE issues SET status = ? WHERE id = ?
      `);
      updateStmt.run(status, id);

      // Add system comment for status change
      this.addCommentSync(id, `Status changed to ${status}`, 'system');

      // Add closing comment if provided
      if (comment) {
        this.addCommentSync(id, comment, poster || owner);
      }

      // Remove any blockages where this issue is the blocker
      const clearBlockagesStmt = db.prepare(`
        DELETE FROM issue_blockages WHERE blocker_id = ?
      `);
      clearBlockagesStmt.run(id);
    });

    closeTx();
  }

  /**
   * Add a comment to an issue
   */
  async addComment(id: number, comment: string, poster?: string): Promise<void> {
    this.addCommentSync(id, comment, poster || 'anonymous');
  }

  /**
   * Add a comment to an issue (sync internal helper)
   */
  private addCommentSync(id: number, comment: string, poster: string): void {
    const db = getDb();

    const stmt = db.prepare(`
      SELECT comments FROM issues WHERE id = ?
    `);
    const row = stmt.get(id) as { comments: string } | undefined;

    if (!row) return;

    const comments: IssueComment[] = JSON.parse(row.comments || '[]');
    comments.push({
      poster,
      content: comment,
      timestamp: new Date(),
    });

    const updateStmt = db.prepare(`
      UPDATE issues SET comments = ? WHERE id = ?
    `);
    updateStmt.run(JSON.stringify(comments), id);
  }

  /**
   * Create a blockage relationship
   */
  async createBlockage(blocker: number, blocked: number): Promise<void> {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO issue_blockages (blocker_id, blocked_id)
      VALUES (?, ?)
    `);
    stmt.run(blocker, blocked);
  }

  /**
   * Remove a blockage relationship
   */
  async removeBlockage(blocker: number, blocked: number): Promise<void> {
    const db = getDb();
    const stmt = db.prepare(`
      DELETE FROM issue_blockages
      WHERE blocker_id = ? AND blocked_id = ?
    `);
    stmt.run(blocker, blocked);
  }

  /**
   * Convert a database row to an Issue object
   */
  private rowToIssue(row: {
    id: number;
    title: string;
    content: string;
    status: string;
    owner: string | null;
    created_at: string;
    comments: string;
  }): Issue {
    const db = getDb();

    // Get blockages
    const blockedByStmt = db.prepare(`
      SELECT blocker_id FROM issue_blockages WHERE blocked_id = ?
    `);
    const blockedByRows = blockedByStmt.all(row.id) as { blocker_id: number }[];
    const blockedBy = blockedByRows.map((r) => r.blocker_id);

    const blocksStmt = db.prepare(`
      SELECT blocked_id FROM issue_blockages WHERE blocker_id = ?
    `);
    const blocksRows = blocksStmt.all(row.id) as { blocked_id: number }[];
    const blocks = blocksRows.map((r) => r.blocked_id);

    // Parse comments
    const rawComments = JSON.parse(row.comments || '[]');
    const comments: IssueComment[] = rawComments.map((c: { poster: string; content: string; timestamp: string }) => ({
      poster: c.poster,
      content: c.content,
      timestamp: new Date(c.timestamp),
    }));

    return {
      id: row.id,
      title: row.title,
      content: row.content,
      status: row.status as IssueStatus,
      owner: row.owner || undefined,
      blockedBy,
      blocks,
      comments,
      createdAt: new Date(row.created_at),
    };
  }
}

/**
 * Create an issue module instance
 */
export function createIssue(): IssueModule {
  return new IssueManager();
}

/**
 * Create IPC handlers for Issue module
 * These handle DB requests from child processes
 */
export function createIssueIpcHandlers(): IpcHandlerRegistration[] {
  return [
    // Read operations
    {
      messageType: 'db_issue_get',
      module: 'issue',
      handler: async (_sender, payload, ctx) => {
        const { id } = payload as { id: number };
        const issue = await ctx.issue.getIssue(id);
        return { success: true, data: issue };
      },
    },
    {
      messageType: 'db_issue_list',
      module: 'issue',
      handler: async (_sender, _payload, ctx) => {
        const issues = await ctx.issue.listIssues();
        return { success: true, data: issues };
      },
    },
    // Write operations
    {
      messageType: 'db_issue_create',
      module: 'issue',
      handler: async (_sender, payload, ctx) => {
        const { title, content, blockedBy = [] } = payload as {
          title: string;
          content: string;
          blockedBy?: number[];
        };
        const id = await ctx.issue.createIssue(title, content, blockedBy);
        return { success: true, data: { id } };
      },
    },
    {
      messageType: 'db_issue_claim',
      module: 'issue',
      handler: async (_sender, payload, ctx) => {
        const { id, owner } = payload as { id: number; owner: string };
        const claimed = await ctx.issue.claimIssue(id, owner);
        return { success: true, data: { claimed } };
      },
    },
    {
      messageType: 'db_issue_close',
      module: 'issue',
      handler: async (_sender, payload, ctx) => {
        const { id, status, comment, poster } = payload as {
          id: number;
          status: 'completed' | 'failed' | 'abandoned';
          comment?: string;
          poster?: string;
        };
        await ctx.issue.closeIssue(id, status, comment, poster);
        return { success: true };
      },
    },
    {
      messageType: 'db_issue_comment',
      module: 'issue',
      handler: async (_sender, payload, ctx) => {
        const { id, comment, poster } = payload as { id: number; comment: string; poster?: string };
        await ctx.issue.addComment(id, comment, poster);
        return { success: true };
      },
    },
    {
      messageType: 'db_block_add',
      module: 'issue',
      handler: async (_sender, payload, ctx) => {
        const { blocker, blocked } = payload as { blocker: number; blocked: number };
        await ctx.issue.createBlockage(blocker, blocked);
        return { success: true };
      },
    },
    {
      messageType: 'db_block_remove',
      module: 'issue',
      handler: async (_sender, payload, ctx) => {
        const { blocker, blocked } = payload as { blocker: number; blocked: number };
        await ctx.issue.removeBlockage(blocker, blocked);
        return { success: true };
      },
    },
  ];
}