/**
 * vision-config.test.ts - Tests for the provider-aware vision configuration
 *
 * Covers isVisionEnabled() / getVisionModel() resolving the vision model from
 * the correct env var per API provider:
 *   - ollama   → OLLAMA_VISION_MODEL (required; no default; "none" disables)
 *   - deepseek → DEEPSEEK_VISION_MODEL (default deepseek-flash; "none" disables)
 *
 * These were made provider-aware when DeepSeek vision (image input via
 * deepseek-flash) was added; before that both functions read OLLAMA_VISION_MODEL
 * unconditionally, so a DeepSeek install had no way to configure vision.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isVisionEnabled, getVisionModel } from '../config.js';

describe('vision config (provider-aware)', () => {
  const saved = {
    provider: process.env.API_PROVIDER,
    ollamaVision: process.env.OLLAMA_VISION_MODEL,
    deepseekVision: process.env.DEEPSEEK_VISION_MODEL,
  };

  afterEach(() => {
    // Restore the exact prior environment (including unset).
    restore('API_PROVIDER', saved.provider);
    restore('OLLAMA_VISION_MODEL', saved.ollamaVision);
    restore('DEEPSEEK_VISION_MODEL', saved.deepseekVision);
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  describe('ollama provider', () => {
    beforeEach(() => {
      process.env.API_PROVIDER = 'ollama';
      delete process.env.DEEPSEEK_VISION_MODEL;
    });

    it('is disabled when OLLAMA_VISION_MODEL is unset (no default)', () => {
      delete process.env.OLLAMA_VISION_MODEL;
      expect(isVisionEnabled()).toBe(false);
    });

    it('is disabled when OLLAMA_VISION_MODEL=none', () => {
      process.env.OLLAMA_VISION_MODEL = 'none';
      expect(isVisionEnabled()).toBe(false);
    });

    it('is enabled when OLLAMA_VISION_MODEL names a model', () => {
      process.env.OLLAMA_VISION_MODEL = 'gemma4:31b-cloud';
      expect(isVisionEnabled()).toBe(true);
      expect(getVisionModel()).toBe('gemma4:31b-cloud');
    });

    it('getVisionModel throws when unset', () => {
      delete process.env.OLLAMA_VISION_MODEL;
      expect(() => getVisionModel()).toThrow(/OLLAMA_VISION_MODEL is not set/);
    });

    it('getVisionModel throws when none', () => {
      process.env.OLLAMA_VISION_MODEL = 'none';
      expect(() => getVisionModel()).toThrow(/OLLAMA_VISION_MODEL=none/);
    });

    it('ignores DEEPSEEK_VISION_MODEL', () => {
      delete process.env.OLLAMA_VISION_MODEL;
      process.env.DEEPSEEK_VISION_MODEL = 'deepseek-flash';
      expect(isVisionEnabled()).toBe(false);
    });
  });

  describe('deepseek provider', () => {
    beforeEach(() => {
      process.env.API_PROVIDER = 'deepseek';
      delete process.env.OLLAMA_VISION_MODEL;
    });

    it('is enabled by default (deepseek-flash) when DEEPSEEK_VISION_MODEL is unset', () => {
      delete process.env.DEEPSEEK_VISION_MODEL;
      expect(isVisionEnabled()).toBe(true);
      expect(getVisionModel()).toBe('deepseek-flash');
    });

    it('is disabled when DEEPSEEK_VISION_MODEL=none', () => {
      process.env.DEEPSEEK_VISION_MODEL = 'none';
      expect(isVisionEnabled()).toBe(false);
      expect(() => getVisionModel()).toThrow(/DEEPSEEK_VISION_MODEL=none/);
    });

    it('honours an explicit DEEPSEEK_VISION_MODEL', () => {
      process.env.DEEPSEEK_VISION_MODEL = 'deepseek-flash';
      expect(getVisionModel()).toBe('deepseek-flash');
    });

    it('ignores OLLAMA_VISION_MODEL', () => {
      process.env.OLLAMA_VISION_MODEL = 'gemma4:31b-cloud';
      delete process.env.DEEPSEEK_VISION_MODEL;
      expect(getVisionModel()).toBe('deepseek-flash');
    });
  });
});
