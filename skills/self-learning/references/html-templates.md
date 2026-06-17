# HTML Templates

All HTML files: single self-contained `.html` with Bootstrap 5 + jQuery via CDN.

Use **data-driven jQuery** approach: define data in JS, render DOM from it. This constrains LLM output to just filling data arrays, avoiding fragile layout generation.

## Core Setup (CDN)

```html
<!-- Bootstrap 5 CSS -->
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<!-- jQuery -->
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<!-- Bootstrap 5 JS -->
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
```

## Template: Roadmap (`roadmap.html`)

<!--
  PURPOSE: Concept timeline with progress tracking.
  LLM WORK: Only replace the `data` object — the render logic is fixed.
-->

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Roadmap - {topic}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
  <style>
    .tl-card { border-left:4px solid #ccc; margin-bottom:12px; }
    .tl-card.mastered { border-color:#198754; }
    .tl-card.active   { border-color:#0d6efd; }
    .tl-card.pending  { border-color:#6c757d; }
  </style>
</head>
<body class="bg-light">
  <div class="container py-4" style="max-width:720px;">
    <div id="app"></div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    // ─── DATA: LLM replaces this object ───
    const data = {
      topic: "Python decorators",
      mastered: 3,
      total: 8,
      // Each concept: { name, status: "mastered"|"active"|"pending", score }
      concepts: [
        { name: "Functions as objects",  status: "mastered", score: 95 },
        { name: "Closures",              status: "mastered", score: 88 },
        { name: "Decorator syntax",      status: "active",   score: 65 },
        { name: "Wrapping with args",    status: "pending",  score: 0  },
      ]
    };
    // ─── RENDER (fixed) ───
    const statusMeta = {
      mastered: { badge: "bg-success", label: "Mastered", icon: "✓" },
      active:   { badge: "bg-primary", label: "Active",   icon: "⟳" },
      pending:  { badge: "bg-secondary", label: "Pending", icon: "○" },
    };
    const pct = data.total > 0 ? Math.round(data.mastered/data.total*100) : 0;
    const cards = data.concepts.map(c => {
      const m = statusMeta[c.status] || statusMeta.pending;
      return `<div class="card tl-card ${c.status}">
        <div class="card-body d-flex justify-content-between align-items-center">
          <span><strong>${m.icon} ${c.name}</strong></span>
          <span class="badge ${m.badge}">${c.score}% - ${m.label}</span>
        </div>
      </div>`;
    }).join('');
    $('#app').html(`
      <div class="text-center mb-4">
        <h3>${data.topic}</h3>
        <div class="progress mx-auto" style="width:200px;height:10px;">
          <div class="progress-bar bg-success" style="width:${pct}%"></div>
        </div>
        <span class="badge bg-success mt-2">${data.mastered}/${data.total}</span>
      </div>
      ${cards}
    `);
  </script>
</body>
</html>
```

## Template: Summary (`summary.html`)

<!--
  PURPOSE: Session end report.
  LLM WORK: Only replace the `data` object.
-->

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Summary - {topic}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
  <style>
    .stat-card { border-radius:12px; text-align:center; padding:1.5rem; }
  </style>
</head>
<body class="bg-light">
  <div class="container py-4" style="max-width:720px;">
    <div id="app"></div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    // ─── DATA: LLM replaces this object ───
    const data = {
      topic: "Python decorators",
      stats: [
        { label: "Mastered",      value: "3",         color: "primary" },
        { label: "Questions",     value: "24",        color: "success" },
        { label: "Mastery Rate",  value: "83%",       color: "warning" },
        { label: "Misconceptions Resolved", value: "2", color: "info" },
      ],
      // Each concept: { name, score }
      concepts: [
        { name: "Functions as objects", score: 95 },
        { name: "Closures",             score: 88 },
        { name: "Decorator syntax",     score: 65 },
      ],
      insights: [
        "Strong understanding of first-class functions",
        "Closure variable capture is clear after counter-example",
        "Needs more practice with decorator arguments",
      ],
      nextSteps: [
        "Practice writing decorators with optional arguments",
        "Explore class-based decorators",
        "Review functools.wraps usage",
      ],
    };
    // ─── RENDER (fixed) ───
    const statsHtml = data.stats.map(s =>
      `<div class="col-6 col-md-3 mb-3">
        <div class="card stat-card">
          <div class="fs-2 fw-bold text-${s.color}">${s.value}</div>
          <div class="text-muted small">${s.label}</div>
        </div>
      </div>`
    ).join('');
    const chartHtml = data.concepts.map(c =>
      `<div class="mb-2">
        <div class="d-flex justify-content-between"><span>${c.name}</span><span>${c.score}%</span></div>
        <div class="progress" style="height:8px;">
          <div class="progress-bar bg-primary" style="width:${c.score}%"></div>
        </div>
      </div>`
    ).join('');
    const insightHtml = data.insights.map(i =>
      `<li class="list-group-item border-start border-primary border-3">${i}</li>`
    ).join('');
    const nextHtml = data.nextSteps.map(s =>
      `<li class="list-group-item border-start border-success border-3">${s}</li>`
    ).join('');
    $('#app').html(`
      <h3 class="text-center mb-4">Session Summary: ${data.topic}</h3>
      <div class="row g-2 mb-4">${statsHtml}</div>
      <div class="card mb-3"><div class="card-header fw-bold">Concept Breakdown</div><div class="card-body">${chartHtml}</div></div>
      <div class="card mb-3"><div class="card-header fw-bold">Key Insights</div><ul class="list-group list-group-flush">${insightHtml}</ul></div>
      <div class="card"><div class="card-header fw-bold">Next Steps</div><ul class="list-group list-group-flush">${nextHtml}</ul></div>
    `);
  </script>
</body>
</html>
```

## Template: Visual Explanation (`visuals/*.html`)

<!--
  PURPOSE: Step-by-step code walkthroughs.
  LLM WORK: Only replace the `data` object.
-->

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
  <style>
    .step { display:flex; gap:12px; margin-bottom:16px; }
    .step-num {
      background:#0d6efd; color:#fff; width:28px; height:28px;
      border-radius:50%; display:flex; align-items:center; justify-content:center;
      font-weight:bold; font-size:14px; flex-shrink:0;
    }
    .code { background:#1e1e1e; color:#d4d4d4; border-radius:6px; padding:16px; font-family:monospace; font-size:14px; overflow-x:auto; }
  </style>
</head>
<body class="bg-light">
  <div class="container py-4" style="max-width:720px;">
    <div id="app"></div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    // ─── DATA: LLM replaces this object ───
    const data = {
      title: "How a Decorator Works",
      // Each step: { text, code? }
      steps: [
        { text: "Define a function that takes another function as argument", code: "def my_decorator(fn):" },
        { text: "Inside, define a wrapper function", code: "    def wrapper():\n        print('before')\n        fn()\n        print('after')" },
        { text: "Return the wrapper without calling it", code: "    return wrapper" },
        { text: "Apply the decorator with @ syntax", code: "@my_decorator\ndef hello():\n    print('hi')" },
        { text: "Calling hello() now runs the wrapper", code: "hello()\n# Output:\n# before\n# hi\n# after" },
      ],
    };
    // ─── RENDER (fixed) ───
    const stepsHtml = data.steps.map((s, i) =>
      `<div class="step">
        <div class="step-num">${i+1}</div>
        <div class="flex-grow-1">
          <p class="mb-1">${s.text}</p>
          ${s.code ? `<pre class="code mb-0">${s.code}</pre>` : ''}
        </div>
      </div>`
    ).join('');
    $('#app').html(`<h4 class="mb-3">${data.title}</h4>${stepsHtml}`);
  </script>
</body>
</html>
```

## Excalidraw Concept Maps (`concept-map/*.html`)

<!--
  See references/excalidraw.md for element format.
  LLM WORK: Only replace the `elementsData` array.
-->

## Usage Guidelines

- **LLM scope**: Only edit the `data = { ... }` object (or `elementsData` for Excalidraw)
- **Render code is FIXED** — do not modify
- **Output path**: `sigma/{topic}/roadmap.html`, `sigma/{topic}/summary.html`, `sigma/{topic}/visuals/*.html`
- **Open command**: `bash` tool to run `open <path>` (Linux/macOS) or `start <path>` (Windows)
- **Do NOT auto-open** after every round — only on first generation or when user asks
