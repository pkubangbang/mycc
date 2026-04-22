/**
 * memory-store.ts - In-memory storage for session-scoped data
 *
 * This module provides volatile storage that exists only for the
 * duration of the session. Data is lost when the process exits.
 */

import type { Issue, Teammate, TeammateStatus } from '../types.js';

// In-memory stores (session-scoped)
const issues: Map<number, Issue> = new Map();
const blockages: Map<string, { blocker: number; blocked: number }> = new Map();
const teammates: Map<string, Teammate> = new Map();

// ID counter for issues
let nextIssueId = 1;

// Blockage key helper
function blockageKey(blocker: number, blocked: number): string {
  return `${blocker}:${blocked}`;
}

// ============================================================================
// Issue Operations
// ============================================================================

export function createIssue(title: string, content: string, blockedBy: number[]): number {
  const id = nextIssueId++;
  const now = new Date();

  const issue: Issue = {
    id,
    title,
    content,
    status: 'pending',
    blockedBy: [],
    blocks: [],
    comments: [
      {
        poster: 'system',
        content: `Created issue "${title}"`,
        timestamp: now,
      },
    ],
    createdAt: now,
  };

  issues.set(id, issue);

  // Create blockages
  for (const blockerId of blockedBy) {
    createBlockage(blockerId, id);
  }

  return id;
}

export function getIssue(id: number): Issue | undefined {
  return issues.get(id);
}

export function listIssues(): Issue[] {
  return Array.from(issues.values());
}

export function updateIssue(id: number, updates: Partial<Issue>): boolean {
  const issue = issues.get(id);
  if (!issue) return false;
  issues.set(id, { ...issue, ...updates });
  return true;
}

export function addIssueComment(id: number, comment: string, poster: string): boolean {
  const issue = issues.get(id);
  if (!issue) return false;
  issue.comments.push({ poster, content: comment, timestamp: new Date() });
  return true;
}

// ============================================================================
// Blockage Operations
// ============================================================================

export function createBlockage(blocker: number, blocked: number): void {
  blockages.set(blockageKey(blocker, blocked), { blocker, blocked });

  // Update issue relationships
  const blockedIssue = issues.get(blocked);
  const blockerIssue = issues.get(blocker);
  if (blockedIssue && !blockedIssue.blockedBy.includes(blocker)) {
    blockedIssue.blockedBy.push(blocker);
  }
  if (blockerIssue && !blockerIssue.blocks.includes(blocked)) {
    blockerIssue.blocks.push(blocked);
  }
}

export function removeBlockage(blocker: number, blocked: number): void {
  blockages.delete(blockageKey(blocker, blocked));

  // Update issue relationships
  const blockedIssue = issues.get(blocked);
  const blockerIssue = issues.get(blocker);
  if (blockedIssue) {
    blockedIssue.blockedBy = blockedIssue.blockedBy.filter((id) => id !== blocker);
  }
  if (blockerIssue) {
    blockerIssue.blocks = blockerIssue.blocks.filter((id) => id !== blocked);
  }
}

// ============================================================================
// Teammate Operations
// ============================================================================

export function createTeammate(name: string, role: string, prompt: string): void {
  teammates.set(name, {
    name,
    role,
    status: 'working',
    prompt,
    createdAt: new Date(),
  });
}

export function getTeammate(name: string): Teammate | undefined {
  return teammates.get(name);
}

export function listTeammates(): Teammate[] {
  return Array.from(teammates.values());
}

export function updateTeammateStatus(name: string, status: TeammateStatus): boolean {
  const teammate = teammates.get(name);
  if (!teammate) return false;
  teammate.status = status;
  return true;
}

export function removeTeammate(name: string): boolean {
  return teammates.delete(name);
}

// ============================================================================
// Clear All Session Data
// ============================================================================

export function clearAll(): void {
  issues.clear();
  blockages.clear();
  teammates.clear();
  nextIssueId = 1;
}