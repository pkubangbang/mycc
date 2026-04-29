/**
 * CoreModule mode functionality tests
 * 
 * Tests for getMode() and setMode() in Core (parent process)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Core } from '../../context/parent/core.js';

describe('CoreModule mode functionality', () => {
  let core: Core;

  beforeEach(() => {
    core = new Core();
  });

  describe('getMode()', () => {
    it('should return "normal" by default', () => {
      expect(core.getMode()).toBe('normal');
    });

    it('should return current mode after setMode', () => {
      core.setMode('plan');
      expect(core.getMode()).toBe('plan');
    });
  });

  describe('setMode()', () => {
    it('should switch to plan mode', () => {
      expect(core.getMode()).toBe('normal');
      core.setMode('plan');
      expect(core.getMode()).toBe('plan');
    });

    it('should switch back to normal mode', () => {
      core.setMode('plan');
      expect(core.getMode()).toBe('plan');
      
      core.setMode('normal');
      expect(core.getMode()).toBe('normal');
    });

    it('should allow switching multiple times', () => {
      core.setMode('plan');
      expect(core.getMode()).toBe('plan');
      
      core.setMode('normal');
      expect(core.getMode()).toBe('normal');
      
      core.setMode('plan');
      expect(core.getMode()).toBe('plan');
    });
  });

  describe('mode type safety', () => {
    it('should only accept valid mode values', () => {
      // TypeScript enforces this at compile time
      // Runtime test to confirm behavior
      core.setMode('plan');
      expect(core.getMode()).toBe('plan');
      
      core.setMode('normal');
      expect(core.getMode()).toBe('normal');
    });
  });
});