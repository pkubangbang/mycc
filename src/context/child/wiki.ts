/**
 * wiki.ts - ChildWiki implementation for IPC-based wiki operations
 */

import type { WikiModule, WikiDocument, WikiDomain, PrepareResult, PutResult, GetOptions, SearchResult, WALEntry, RebuildResult, RebuildProgress, SkillIndexEntry } from '../../types.js';
import { ipc } from './ipc-helpers.js';

/**
 * Wiki module for child process
 * All operations go through IPC to parent
 */
export class ChildWiki implements WikiModule {
  async prepare(document: WikiDocument, skipDuplicateCheck?: boolean): Promise<PrepareResult> {
    const result = await ipc.sendRequest<PrepareResult>('wiki_prepare', { document, skipDuplicateCheck });
    return result;
  }

  async put(hash: string, document: WikiDocument): Promise<PutResult> {
    const result = await ipc.sendRequest<PutResult>('wiki_put', { hash, document });
    return result;
  }

  async get(query: string, options?: GetOptions): Promise<SearchResult[]> {
    const result = await ipc.sendRequest<SearchResult[]>('wiki_get', { query, options });
    return result;
  }

  async getByDomain(domain: string): Promise<SearchResult[]> {
    const result = await ipc.sendRequest<SearchResult[]>('wiki_get_by_domain', { domain });
    return result;
  }

  async batchPut(entries: Array<{ document: WikiDocument; embedding: number[] }>): Promise<PutResult[]> {
    const result = await ipc.sendRequest<PutResult[]>('wiki_batch_put', { entries });
    return result;
  }

  async delete(hash: string): Promise<boolean> {
    const result = await ipc.sendRequest<boolean>('wiki_delete', { hash });
    return result;
  }

  async getWAL(date?: string): Promise<WALEntry[]> {
    const result = await ipc.sendRequest<WALEntry[]>('wiki_wal_get', { date });
    return result;
  }

  async appendWAL(entry: WALEntry): Promise<void> {
    await ipc.sendRequest<void>('wiki_wal_append', { entry });
  }

  async rebuild(_onProgress?: (progress: RebuildProgress) => void): Promise<RebuildResult> {
    // Progress is parent-side only: the callback is a local terminal UI hook
    // and does not survive the IPC hop, so a child rebuild simply omits it.
    const result = await ipc.sendRequest<RebuildResult>('wiki_rebuild', {});
    return result;
  }

  // Domain management
  async listDomains(): Promise<WikiDomain[]> {
    const result = await ipc.sendRequest<WikiDomain[]>('wiki_domains_list', {});
    return result;
  }

  async getDomain(name: string): Promise<WikiDomain | undefined> {
    const result = await ipc.sendRequest<WikiDomain | undefined>('wiki_domain_get', { name });
    return result;
  }

  async registerDomain(name: string, description?: string): Promise<void> {
    await ipc.sendRequest<void>('wiki_domain_register', { name, description });
  }

  /**
   * Re-index skills into the wiki. This is a PARENT-ONLY operation: the
   * parent's loader builds the skill entries (it owns the skill map) and
   * calls indexSkills on the real WikiManager, which holds the reindex lock
   * and does the batch DB write. A child (teammate) never drives a re-index
   * — its skill edits trigger an IPC 'skill_reindex' signal to the parent,
   * which re-indexes. So this stub is never invoked at runtime; it exists
   * only to satisfy the WikiModule interface. No-op (resolves immediately).
   */
  async indexSkills(_entries: SkillIndexEntry[], _options?: { skipOrphanSweep?: boolean }): Promise<void> {
    // Parent-only — no IPC delegation, no-op in the child.
  }

}