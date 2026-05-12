/**
 * token.ts - Token estimation utility
 *
 * Provides fast token approximation for messages, optimized for both
 * Western languages and CJK (Chinese, Japanese, Korean).
 *
 * Heuristics:
 * - Western: ~1.33 tokens per word (subword tokenization overhead)
 * - CJK: ~2 tokens per character (characters are tokens + overhead)
 * - Message structure: fixed overhead per message
 */

import type { Message } from '../types.js';

// Token multipliers
const WESTERN_TOKEN_RATIO = 1.33; // Words to tokens (GPT-style tokenization)
const CJK_TOKEN_RATIO = 2.0; // Characters to tokens (with overhead)
const MESSAGE_OVERHEAD = 4; // Role + formatting tokens

/**
 * Estimate tokens in text using language-aware approximation
 */
function estimateTextTokens(text: string): number {
  if (!text) return 0;

  let westernTokens = 0;
  let cjkTokens = 0;
  let wordLen = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isCJKChar = code >= 0x4e00 && code <= 0x9fff || // Most common CJK
      code >= 0x3400 && code <= 0x4dbf || // Extension A
      code >= 0x3040 && code <= 0x309f || // Hiragana
      code >= 0x30a0 && code <= 0x30ff || // Katakana
      code >= 0xac00 && code <= 0xd7af || // Hangul
      code >= 0x1100 && code <= 0x11ff || // Hangul Jamo
      code >= 0x3000 && code <= 0x303f || // CJK punctuation
      code >= 0xff00 && code <= 0xffef; // Half/Fullwidth

    if (isCJKChar) {
      // Flush pending western word
      if (wordLen > 0) {
        westernTokens += wordLen > 6 ? wordLen * 0.5 : wordLen * 0.75;
        wordLen = 0;
      }
      cjkTokens++;
    } else {
      const char = text[i];
      if (/\s/.test(char)) {
        // Whitespace: flush word and count as token
        if (wordLen > 0) {
          westernTokens += wordLen > 6 ? wordLen * 0.5 : wordLen * 0.75;
          wordLen = 0;
        }
        // Most whitespace is merged into adjacent tokens
      } else if (/[^\w]/.test(char)) {
        // Punctuation: flush word, count as ~0.5 tokens
        if (wordLen > 0) {
          westernTokens += wordLen > 6 ? wordLen * 0.5 : wordLen * 0.75;
          wordLen = 0;
        }
        westernTokens += 0.5;
      } else {
        // Western character - accumulate word
        wordLen++;
      }
    }
  }

  // Flush remaining word
  if (wordLen > 0) {
    westernTokens += wordLen > 6 ? wordLen * 0.5 : wordLen * 0.75;
  }

  return Math.ceil(westernTokens * WESTERN_TOKEN_RATIO + cjkTokens * CJK_TOKEN_RATIO);
}

/**
 * Estimate token count for a single message
 */
export function estimateTokens(message: Message): number {
  let total = MESSAGE_OVERHEAD;

  if (message.content) {
    total += estimateTextTokens(message.content);
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      // Tool call overhead: name + id + structure
      total += 6;
      total += estimateTextTokens(tc.function.name);
      total += estimateTextTokens(JSON.stringify(tc.function.arguments));
    }
  }

  return total;
}

/**
 * Estimate token count for an array of messages
 */
export function estimateTokensForMessages(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}