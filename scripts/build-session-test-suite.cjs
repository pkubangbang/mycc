#!/usr/bin/env node
/**
 * build-session-test-suite.cjs — Convert the raw extracted crossroad triggers
 * (from extract-crossroad-triggers.cjs) into a proper test suite under
 * ~/.mycc-store/crossroad-trainer/tests/test_cases/session_triggers/
 *
 * These are REAL production crossroad-triggered texts harvested from session
 * triologue files — the most genuine test data available. The vitest eval
 * test (crossroad-encoder-eval.test.ts) recursively scans test_cases/, so
 * placing files here makes them automatically part of the eval suite.
 *
 * Output layout:
 *   tests/test_cases/session_triggers/
 *     session_turns_en.jsonl      (label=1, English)
 *     session_turns_zh.jsonl      (label=1, Chinese)
 *     session_no_turns_en.jsonl   (label=0, English)
 *     session_no_turns_zh.jsonl   (label=0, Chinese)
 *
 * Each line: { text, label, turnIndex?, note, source }
 *   - label 1 = crossroad fired (turn detected)
 *   - label 0 = normal assistant response (no turn)
 *   - turnIndex = index of turning word in text (if found), else omitted
 *   - note = human-readable description
 *   - source = session id + triologue file
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const INPUT_FILE = path.join(os.homedir(), '.mycc-store', 'crossroad-trainer', 'data', 'crossroad-from-sessions.jsonl');
const OUTPUT_DIR = path.join(os.homedir(), '.mycc-store', 'crossroad-trainer', 'tests', 'test_cases', 'session_triggers');

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
  for (const word of [...TURN_WORDS_EN, ...TURN_WORDS_ZH]) {
    const idx = text.indexOf(word);
    if (idx >= 0) {
      if (idx === 0) return { word, index: idx };
      const before = text.slice(Math.max(0, idx - 3), idx);
      if (/[.!?。！？\n]/.test(before) || /\s/.test(before)) return { word, index: idx };
    }
  }
  return null;
}

// Detect language: if text contains CJK characters, treat as Chinese.
function isChinese(text) {
  // Count CJK Unified Ideograph characters
  const cjk = text.match(/[\u4e00-\u9fff]/g);
  const cjkCount = cjk ? cjk.length : 0;
  // If more than 5% of non-whitespace chars are CJK, classify as Chinese
  const nonWs = text.replace(/\s/g, '').length;
  return nonWs > 0 && cjkCount / nonWs > 0.05;
}

function parseJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return rows;
}

function buildSuite() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`ERROR: Input file not found: ${INPUT_FILE}`);
    console.error('Run scripts/extract-crossroad-triggers.cjs first.');
    process.exit(1);
  }

  const rows = parseJsonl(INPUT_FILE);
  console.log(`Loaded ${rows.length} rows from ${INPUT_FILE}`);

  // Buckets
  const turnsEn = [];
  const turnsZh = [];
  const noTurnsEn = [];
  const noTurnsZh = [];

  for (const r of rows) {
    if (typeof r.text !== 'string' || (r.label !== 0 && r.label !== 1)) continue;
    const zh = isChinese(r.text);
    const entry = {
      text: r.text,
      label: r.label,
    };
    if (r.label === 1) {
      const tw = findTurningWord(r.text);
      if (tw) entry.turnIndex = tw.index;
      entry.note = tw
        ? `real crossroad trigger (turn word: "${tw.word}")`
        : 'real crossroad trigger (reasoning pivot, no single turn word)';
      if (r.source) entry.source = r.source;
    } else {
      entry.note = 'real assistant response — no crossroad fired';
      entry.source = 'session:no-turn';
    }

    if (r.label === 1) {
      if (zh) turnsZh.push(entry); else turnsEn.push(entry);
    } else {
      if (zh) noTurnsZh.push(entry); else noTurnsEn.push(entry);
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = [
    { name: 'session_turns_en.jsonl', data: turnsEn },
    { name: 'session_turns_zh.jsonl', data: turnsZh },
    { name: 'session_no_turns_en.jsonl', data: noTurnsEn },
    { name: 'session_no_turns_zh.jsonl', data: noTurnsZh },
  ];

  let totalWritten = 0;
  for (const f of files) {
    const outPath = path.join(OUTPUT_DIR, f.name);
    const content = f.data.map(e => JSON.stringify(e)).join('\n') + (f.data.length ? '\n' : '');
    fs.writeFileSync(outPath, content, 'utf8');
    console.log(`  ${f.name}: ${f.data.length} samples`);
    totalWritten += f.data.length;
  }

  console.log(`\nWrote ${totalWritten} samples to ${OUTPUT_DIR}`);
  console.log(`  label=1 (turns):    EN=${turnsEn.length}  ZH=${turnsZh.length}`);
  console.log(`  label=0 (no-turns): EN=${noTurnsEn.length}  ZH=${noTurnsZh.length}`);

  // Sanity: report any empty buckets
  const empties = files.filter(f => f.data.length === 0).map(f => f.name);
  if (empties.length) {
    console.log(`\nNOTE: empty buckets: ${emptes.join(', ')}`);
  }

  // Turn-index coverage among turns
  const allTurns = [...turnsEn, ...turnsZh];
  const withIdx = allTurns.filter(t => typeof t.turnIndex === 'number').length;
  console.log(`\nTurn-index coverage: ${withIdx}/${allTurns.length} turns have a detectable turn word`);
}

buildSuite();