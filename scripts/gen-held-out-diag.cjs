// gen-held-out-diag.cjs — diagnose why the model performs near-random on held-out data.
// Prints probability distribution by label and length bucket.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HELD_OUT_DIR = path.join(os.homedir(), '.mycc-store', 'crossroad-trainer', 'tests', 'held_out');

function collectJsonlFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsonlFiles(full));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function loadJsonl(file) {
  const samples = [];
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (typeof o.text === 'string' && (o.label === 0 || o.label === 1)) {
        samples.push({ text: o.text, label: o.label, file });
      }
    } catch {}
  }
  return samples;
}

// Load the ONNX model the same way crossroad-encoder.ts does.
async function main() {
  const ort = require('onnxruntime-node');
  const { AutoTokenizer } = require('@huggingface/transformers');
  const modelDir = path.join(os.homedir(), '.mycc-store', 'crossroad-model');
  const config = JSON.parse(fs.readFileSync(path.join(modelDir, 'config.json'), 'utf-8'));
  const modelPath = path.join(modelDir, 'model.onnx');
  const session = await ort.InferenceSession.create(modelPath);
  const tokenizer = await AutoTokenizer.from_pretrained(modelDir);

  const files = collectJsonlFiles(HELD_OUT_DIR);
  const samples = [];
  for (const f of files) samples.push(...loadJsonl(f));
  console.log(`Loaded ${samples.length} held-out samples from ${files.length} files`);

  const results = []; // {label, prob, len, lang}
  let n = 0;
  for (const s of samples) {
    const enc = tokenizer.encode(s.text);
    const ids = Array.isArray(enc) ? enc : enc.data;
    const maxLen = config.maxSequenceLength || 512;
    let inputIds = ids.slice(0, maxLen);
    const padLen = maxLen - inputIds.length;
    const attention = new Array(inputIds.length).fill(1n).concat(new Array(padLen).fill(0n));
    inputIds = inputIds.concat(new Array(padLen).fill(0n));
    const bigIds = BigInt64Array.from(inputIds.map(x => BigInt(x)));
    const bigAtt = BigInt64Array.from(attention);
    const feeds = {
      input_ids: new ort.Tensor('int64', bigIds, [1, maxLen]),
      attention_mask: new ort.Tensor('int64', bigAtt, [1, maxLen]),
    };
    const out = await session.run(feeds);
    const logits = out.logits ? out.logits.data : Object.values(out)[0].data;
    const maxLogit = Math.max(...logits);
    const exps = logits.map(l => Math.exp(l - maxLogit));
    const sumExp = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(e => e / sumExp);
    const probTurn = probs[1]; // index 1 = "turn" class
    const lang = path.basename(path.dirname(s.file)) === 'en' ? 'en' : 'zh';
    results.push({ label: s.label, prob: probTurn, len: s.text.length, lang });
    n++;
    if (n % 100 === 0) console.log(`  processed ${n}/${samples.length}`);
  }

  // Summary by label
  for (const labelVal of [1, 0]) {
    const sub = results.filter(r => r.label === labelVal);
    const probs = sub.map(r => r.prob);
    const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
    const aboveThresh = probs.filter(p => p >= 0.7).length;
    console.log(`\nLabel=${labelVal} (n=${sub.length}): avgProb=${avg.toFixed(3)}, prob>=0.7: ${aboveThresh}/${sub.length}`);
    const sorted = probs.sort((a, b) => a - b);
    console.log(`  prob percentiles: p10=${sorted[Math.floor(sub.length*0.1)].toFixed(3)} p50=${sorted[Math.floor(sub.length*0.5)].toFixed(3)} p90=${sorted[Math.floor(sub.length*0.9)].toFixed(3)}`);
  }

  // By length bucket
  console.log('\n=== By length bucket ===');
  const buckets = [[50,99],[100,199],[200,299],[300,399],[400,500]];
  for (const [lo, hi] of buckets) {
    const sub = results.filter(r => r.len >= lo && r.len <= hi);
    if (sub.length === 0) continue;
    const pos = sub.filter(r => r.label === 1);
    const neg = sub.filter(r => r.label === 0);
    const posAvg = pos.length ? (pos.reduce((a, r) => a + r.prob, 0) / pos.length).toFixed(3) : 'N/A';
    const negAvg = neg.length ? (neg.reduce((a, r) => a + r.prob, 0) / neg.length).toFixed(3) : 'N/A';
    // accuracy at 0.7
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const r of sub) {
      const pred = r.prob >= 0.7 ? 1 : 0;
      if (pred === 1 && r.label === 1) tp++;
      else if (pred === 1 && r.label === 0) fp++;
      else if (pred === 0 && r.label === 0) tn++;
      else fn++;
    }
    const acc = ((tp + tn) / sub.length).toFixed(3);
    console.log(`  [${lo}-${hi}] n=${sub.length} (pos=${pos.length} neg=${neg.length}) | posAvgProb=${posAvg} negAvgProb=${negAvg} | acc@0.7=${acc} (tp=${tp} fp=${fp} tn=${tn} fn=${fn})`);
  }

  // By language
  console.log('\n=== By language ===');
  for (const lang of ['en', 'zh']) {
    const sub = results.filter(r => r.lang === lang);
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const r of sub) {
      const pred = r.prob >= 0.7 ? 1 : 0;
      if (pred === 1 && r.label === 1) tp++;
      else if (pred === 1 && r.label === 0) fp++;
      else if (pred === 0 && r.label === 0) tn++;
      else fn++;
    }
    const acc = ((tp + tn) / sub.length).toFixed(3);
    console.log(`  ${lang}: n=${sub.length} acc@0.7=${acc} (tp=${tp} fp=${fp} tn=${tn} fn=${fn})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });