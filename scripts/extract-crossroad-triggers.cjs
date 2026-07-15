#!/usr/bin/env node
/**
 * extract-crossroad-triggers.cjs — Scan all session triologue JSONL files,
 * find every crossroad trigger event (marked by a brief tool call with
 * "Resolved my direction. Let me continue with the tools."), and extract
 * the assistant content that was the crossroad result (truncated prefix +
 * continuation). This is the text the crossroad encoder should detect as
 * "turn" (label=1).
 *
 * Also extract the PRECEDING assistant message (if any) as a potential
 * no-turn (label=0) example — these are normal LLM responses that did NOT
 * trigger crossroad.
 *
 * Output: ~/.mycc-store/crossroad-trainer/data/crossroad-from-sessions.jsonl
 * Each line: {"text": "...", "label": 1, "source": "session:<id>", "turnWord": "..."}
 *
 * For label=0 (no-turn), we collect assistant messages that:
 *   - appear right before a user/note message (end of a turn, no crossroad fired)
 *   - are substantive (>60 chars, not just tool call wrappers)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(process.cwd(), '.mycc', 'sessions');
const OUTPUT_DIR = path.join(os.homedir(), '.mycc-store', 'crossroad-trainer', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'crossroad-from-sessions.jsonl');

const CROSSROAD_MARKER = 'Resolved my direction. Let me continue with the tools.';

// Turning words to detect in the extracted text
const TURN_WORDS_EN = [
  'However', 'But', 'Wait', 'Actually', 'That said', 'On the other hand',
  'Having said that', 'Nevertheless', 'Then again', 'On second thought',
  'That being said', 'Mind you', 'Still', 'Yet', 'Even so',
];
const TURN_WORDS_ZH = [
  '然而', '不过', '但是', '话说回来', '等一下', '不对', '其实', '另一方面',
  '反过来看', '转念一想', '话虽如此', '尽管如此',
];

function findTurningWord(text) {
  // Search for turning words at sentence boundaries
  for (const word of [...TURN_WORDS_EN, ...TURN_WORDS_ZH]) {
    const idx = text.indexOf(word);
    if (idx >= 0) {
      // Check it's at a sentence boundary (preceded by . ! ? 。！？ \n or start)
      if (idx === 0) return { word, index: idx };
      const before = text.slice(Math.max(0, idx - 3), idx);
      if (/[.!?。！？\n]/.test(before) || /\s/.test(before)) return { word, index: idx };
    }
  }
  return null;
}

function collectTriologueFiles() {
  const files = [];
  if (!fs.existsSync(SESSIONS_DIR)) return files;
  for (const sessionDir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!sessionDir.isDirectory()) continue;
    const sessionPath = path.join(SESSIONS_DIR, sessionDir.name);
    for (const file of fs.readdirSync(sessionPath)) {
      if (file.startsWith('triologue-') && file.endsWith('.jsonl')) {
        files.push({ path: path.join(sessionPath, file), session: sessionDir.name, file });
      }
    }
  }
  return files;
}

function parseJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const messages = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      messages.push(JSON.parse(t));
    } catch {}
  }
  return messages;
}

function extractCrossroadTriggers() {
  const files = collectTriologueFiles();
  console.log(`Found ${files.length} triologue files`);

  const triggers = []; // label=1: crossroad-fired texts
  const noTurns = new Set(); // label=0: normal assistant texts (deduped)
  let totalScanned = 0;

  for (const { path: filePath, session, file } of files) {
    const messages = parseJsonl(filePath);
    totalScanned += messages.length;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Detect crossroad trigger: assistant message with brief tool call
      // containing the marker. arguments may be a string (raw JSON) or an
      // already-parsed object.
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        const hasMarker = msg.tool_calls.some(tc => {
          if (tc.function?.name !== 'brief') return false;
          const args = tc.function?.arguments;
          if (typeof args === 'string') {
            return args.includes(CROSSROAD_MARKER);
          }
          if (args && typeof args === 'object') {
            return typeof args.message === 'string' && args.message.includes(CROSSROAD_MARKER);
          }
          return false;
        });
        if (hasMarker && msg.content) {
          // This is a crossroad result: content = truncated prefix + continuation
          // The text that TRIGGERED crossroad is the full original LLM response
          // (before truncation). But the triologue only stores the truncated+
          // continuation version. The truncated prefix ends at the turning word.
          // We extract the full stored content as the trigger text.
          const text = msg.content.trim();
          if (text.length > 30) {
            const tw = findTurningWord(text);
            triggers.push({
              text,
              label: 1,
              source: `session:${session}:${file}`,
              turnWord: tw ? tw.word : null,
              turnIndex: tw ? tw.index : -1,
            });
          }
        }
      }

      // Collect no-turn examples: substantive assistant messages without
      // crossroad marker (normal responses that did NOT trigger crossroad)
      if (msg.role === 'assistant' && msg.content && !msg.tool_calls) {
        const text = msg.content.trim();
        // Must be substantive, not a tool-call-only wrapper, and not contain
        // a crossroad marker
        if (text.length > 60 && !text.includes(CROSSROAD_MARKER)) {
          // Check it doesn't contain a turning word (to avoid false negatives
          // — these should genuinely be no-turn)
          const tw = findTurningWord(text);
          if (!tw) {
            noTurns.add(text);
          }
        }
      }
    }
  }

  console.log(`Scanned ${totalScanned} total messages`);
  console.log(`Found ${triggers.length} crossroad trigger events (label=1)`);
  console.log(`Found ${noTurns.size} unique no-turn assistant messages (label=0)`);

  // Write output
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outLines = [];

  for (const t of triggers) {
    outLines.push(JSON.stringify(t));
  }

  // Add no-turn examples (limit to match trigger count for balance)
  const noTurnArr = [...noTurns];
  const noTurnCount = Math.min(noTurnArr.length, triggers.length);
  for (let i = 0; i < noTurnCount; i++) {
    outLines.push(JSON.stringify({
      text: noTurnArr[i],
      label: 0,
      source: 'session:no-turn',
    }));
  }

  fs.writeFileSync(OUTPUT_FILE, outLines.join('\n') + '\n', { encoding: 'utf8' });

  // Summary stats
  const posLens = triggers.map(t => t.text.length);
  const negLens = noTurnArr.slice(0, noTurnCount).map(t => t.length);
  const posAvg = posLens.length ? (posLens.reduce((a, b) => a + b, 0) / posLens.length).toFixed(0) : 0;
  const negAvg = negLens.length ? (negLens.reduce((a, b) => a + b, 0) / negLens.length).toFixed(0) : 0;

  console.log(`\nWritten ${outLines.length} samples to ${OUTPUT_FILE}`);
  console.log(`  label=1: ${triggers.length} (avg len=${posAvg})`);
  console.log(`  label=0: ${noTurnCount} (avg len=${negAvg})`);

  // Turn word distribution
  const twCounts = {};
  for (const t of triggers) {
    const w = t.turnWord || '(none found)';
    twCounts[w] = (twCounts[w] || 0) + 1;
  }
  console.log(`\nTurn word distribution:`);
  for (const [w, c] of Object.entries(twCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${w}: ${c}`);
  }

  // Sample previews
  console.log(`\n=== Sample TRIGGER (label=1) #1 ===`);
  if (triggers[0]) {
    console.log(`turnWord: ${triggers[0].turnWord} at index ${triggers[0].turnIndex}`);
    console.log(`text (first 300 chars): ${triggers[0].text.substring(0, 300)}...`);
  }
  console.log(`\n=== Sample NO-TURN (label=0) #1 ===`);
  if (noTurnArr[0]) {
    console.log(`text (first 300 chars): ${noTurnArr[0].substring(0, 300)}...`);
  }
}

extractCrossroadTriggers();