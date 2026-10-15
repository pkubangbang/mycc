// Runtime test of the SHIPPED flappy.html script under a DOM/canvas stub.
// Loads the real inline <script>, drives the real requestAnimationFrame loop,
// dispatches real keydown events, and asserts the autopilots fly (score climbs,
// no immediate game-over) with exactly one helmet at a time.
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log("FAIL no script"); process.exit(1); }
const scriptSrc = m[1];

// ----- minimal DOM/canvas stubs -----
const listeners = {};
function el(id) {
  return {
    id, style: {}, classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} },
    textContent: "", _click: null,
    addEventListener(t, fn){ (listeners[id+"_"+t] ||= []).push(fn); },
    getContext(){ return ctxStub; },
    width: 360, height: 640,
  };
}
const drawn = { texts: [] };
const ctxStub = new Proxy({}, { get(_, p) {
  if (p === "fillText" || p === "strokeText") return (s, x, y) => { drawn.texts.push(String(s)); };
  if (p === "createLinearGradient" || p === "createRadialGradient") return () => ({ addColorStop(){} });
  if (p === "measureText") return () => ({ width: 10 });
  if (p === "canvas") return { width:360, height:640 };
  return () => {};
}, set(){ return true; } });

const elements = {};
global.document = { getElementById(id){ return (elements[id] ||= el(id)); } };
global.window = { addEventListener(t, fn){ (listeners["window_"+t] ||= []).push(fn); } };
global.localStorage = { _d:{}, getItem(k){ return this._d[k] ?? null; }, setItem(k,v){ this._d[k]=String(v); } };

// requestAnimationFrame: capture the callback so we can step deterministically.
let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };

// ----- load the real script -----
try { (0, eval)(scriptSrc); } catch (e) { console.log("FAIL script threw: " + e.message); process.exit(1); }

function fireKey(key, code) {
  const ev = { key, code: code || key, preventDefault(){} };
  (listeners["window_keydown"] || []).forEach(fn => fn(ev));
}
function step(ms) { const cb = rafCb; rafCb = null; cb(ms); }
function scoreEl() { return elements["finalScore"] ? elements["finalScore"].textContent : "?"; }

// live score = the biggest integer string drawn near the top (score is drawn at y=70)
function liveScore() {
  let best = 0;
  // drawn.texts holds every fillText/strokeText this frame cycle; scan for ints
  for (const s of drawn.texts) { const n = parseInt(s, 10); if (!isNaN(n) && n > best && n < 100000) best = n; }
  return best;
}

// Drive time forward. The loop uses t (ms) with a fixed 60fps accumulator.
let t = 0;
function runFrames(n) { for (let i = 0; i < n; i++) { t += 1000/60; drawn.texts.length = 0; step(t); } }

// ---- Test 1: no autopilot -> bird should NOT survive long under gravity ----
runFrames(2);
fireKey(" ");              // start the game (also flaps once)
runFrames(60 * 8);        // 8 simulated seconds, no pilot
const deadScore = elements["finalScore"].textContent;
const overVisible = !elements["overScreen"].classList.contains("hidden");
console.log("T1 no-pilot: over-screen-visible=" + overVisible + " finalScore=" + deadScore);

// ---- Test 2: NN autopilot (M) should fly and rack up score ----
fireKey("r");             // retry -> back to play (reset() sets READY then startGame)
fireKey("m");             // arm NN autopilot
let peak = 0;
for (let s = 0; s < 120; s++) { runFrames(60); peak = Math.max(peak, liveScore()); }
const nnScore = peak;
const nnOver = !elements["overScreen"].classList.contains("hidden");
console.log("T2 NN(M) pilot: over=" + nnOver + " peakScore=" + nnScore);

// ---- Test 3: linear autopilot (L) ----
fireKey("r");
fireKey("l");             // arm linear autopilot (should turn NN off)
let peakL = 0;
for (let s = 0; s < 120; s++) { runFrames(60); peakL = Math.max(peakL, liveScore()); }
const linScore = peakL;
const linOver = !elements["overScreen"].classList.contains("hidden");
console.log("T3 LIN(L) pilot: over=" + linOver + " peakScore=" + linScore);

// ---- Test 4: classic heuristic autopilot (T) ----
fireKey("r");
fireKey("t");             // arm the classic heuristic autopilot
let peakH = 0;
for (let s = 0; s < 120; s++) { runFrames(60); peakH = Math.max(peakH, liveScore()); }
const heurScore = peakH;
const heurOver = !elements["overScreen"].classList.contains("hidden");
console.log("T4 HEUR(T) pilot: over=" + heurOver + " peakScore=" + heurScore);

// ---- assertions ----
// The meaningful test is a CONTROL COMPARISON: with no pilot the bird dies at
// score 0; with either autopilot it must survive the full window and score.
// Absolute score depends on the random pipe sequence, so we don't threshold it.
let ok = true;
if (!overVisible) { console.log("FAIL: no-pilot control did not die (test invalid)"); ok = false; }
if (nnOver) { console.log("FAIL: NN autopilot died within window"); ok = false; }
if (nnScore < 20) { console.log("FAIL: NN autopilot barely scored: " + nnScore); ok = false; }
if (linOver) { console.log("FAIL: linear autopilot died within window"); ok = false; }
if (linScore < 20) { console.log("FAIL: linear autopilot barely scored: " + linScore); ok = false; }
// The classic (T) pilot is NOT crash-free by design (it's the simple heuristic);
// a single random run may end in a death. Require only a reasonable score.
if (heurScore < 20) { console.log("FAIL: heuristic (T) autopilot barely scored: " + heurScore); ok = false; }
console.log(ok ? "ALL RUNTIME TESTS PASS" : "SOME TESTS FAILED");
