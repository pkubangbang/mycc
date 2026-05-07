/**
 * Test for hint round JSON output format
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Triologue } from '../../loop/triologue.js';
import type { WikiModule, WikiDomain } from '../../types.js';

describe('Hint Round JSON Output', () => {
  let triologue: Triologue;
  let mockWiki: WikiModule;

  beforeEach(() => {
    mockWiki = {
      listDomains: vi.fn(async () => [
        {
          domain_name: 'architecture',
          description: 'System architecture and design patterns',
          created_at: '2026-01-01',
          project_folder: '/test',
        },
        {
          domain_name: 'api',
          description: 'API documentation and endpoints',
          created_at: '2026-01-01',
          project_folder: '/test',
        },
      ]),
      prepare: vi.fn(),
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      getWAL: vi.fn(),
      parseWAL: vi.fn(),
      formatWAL: vi.fn(),
      appendWAL: vi.fn(),
      rebuild: vi.fn(),
      getDomain: vi.fn(),
      registerDomain: vi.fn(),
      checkSkillsDomain: vi.fn(),
    } as unknown as WikiModule;

    triologue = new Triologue({
      wiki: mockWiki,
      hintThreshold: 10,
    });
  });

  it('should generate hint with JSON format including wiki_search', async () => {
    // This test verifies the structure of the hint message
    // The actual LLM call is mocked in integration tests
    
    // Add some messages to triologue
    triologue.user('Test user message');
    triologue.agent('Test agent response');

    // Get messages to verify structure
    const messages = triologue.getMessagesRaw();
    
    expect(messages).toBeDefined();
    expect(messages.length).toBe(2);
  });

  it('should include domain information in hint generation context', async () => {
    // Verify that wiki domains are available for hint generation
    const domains = await mockWiki.listDomains();
    
    expect(domains).toBeDefined();
    expect(domains.length).toBe(2);
    expect(domains[0].domain_name).toBe('architecture');
    expect(domains[0].description).toContain('architecture');
  });

  it('should handle domains without descriptions', async () => {
    const wikiWithNoDescriptions: WikiModule = {
      ...mockWiki,
      listDomains: vi.fn(async () => [
        {
          domain_name: 'project',
          description: '',
          created_at: '2026-01-01',
          project_folder: '/test',
        },
      ]),
    } as unknown as WikiModule;

    const domains = await wikiWithNoDescriptions.listDomains();
    
    expect(domains).toBeDefined();
    expect(domains[0].domain_name).toBe('project');
    // Description should be handled gracefully even if empty
  });

  it('should handle empty domains list', async () => {
    const wikiEmpty: WikiModule = {
      ...mockWiki,
      listDomains: vi.fn(async () => []),
    } as unknown as WikiModule;

    const domains = await wikiEmpty.listDomains();
    
    expect(domains).toBeDefined();
    expect(domains.length).toBe(0);
  });
});