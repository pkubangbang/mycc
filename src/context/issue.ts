/**
 * issue.ts - Issue module: persisted tasks with blocking relationships
 */

import type { IssueModule, Issue, IssueStatus } from '../types.js';
import { getDb } from './db.js';

/**
 * Issue module implementation using SQLite
 */
export class IssueManager implements IssueModule {
  /**
   * Create a new issue
   */
  createIssue(title: string, content: string, blockedBy: number[] = []): number {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO issues (title, content, status, owner, comments)
      VALUES (?, ?, 'pending', NULL, '[]')
    `);

    const result = stmt.run(title, content);
    const issueId = result.lastInsertRowid as number;

    // Create blockages
    for (const blockerId of blockedBy) {
      this.createBlockage(blockerId, issueId);
    }

    return issueId;
  }

  /**
   * Get an issue by ID
   */
  getIssue(id: number): Issue | undefined {
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
  listIssues(): Issue[] {
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
  printIssues(): string {
    const issues = this.listIssues();
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
   * Claim an issue (atomic operation)
   */
  claimIssue(id: number, owner: string): boolean {
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
      return result.changes > 0;
    });

    return claimTx();
  }

  /**
   * Close an issue
   */
  closeIssue(id: number, status: 'completed' | 'failed' | 'abandoned', comment?: string): void {
    const db = getDb();

    const closeTx = db.transaction(() => {
      // Update status
      const updateStmt = db.prepare(`
        UPDATE issues SET status = ? WHERE id = ?
      `);
      updateStmt.run(status, id);

      // Add comment if provided
      if (comment) {
        this.addComment(id, comment);
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
  addComment(id: number, comment: string): void {
    const db = getDb();

    const stmt = db.prepare(`
      SELECT comments FROM issues WHERE id = ?
    `);
    const row = stmt.get(id) as { comments: string } | undefined;

    if (!row) return;

    const comments: string[] = JSON.parse(row.comments || '[]');
    comments.push(comment);

    const updateStmt = db.prepare(`
      UPDATE issues SET comments = ? WHERE id = ?
    `);
    updateStmt.run(JSON.stringify(comments), id);
  }

  /**
   * Create a blockage relationship
   */
  createBlockage(blocker: number, blocked: number): void {
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
  removeBlockage(blocker: number, blocked: number): void {
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

    return {
      id: row.id,
      title: row.title,
      content: row.content,
      status: row.status as IssueStatus,
      owner: row.owner || undefined,
      blockedBy,
      blocks,
      comments: JSON.parse(row.comments || '[]'),
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