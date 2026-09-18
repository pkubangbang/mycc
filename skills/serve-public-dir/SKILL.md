---
name: serve-public-dir
description: >
  Use when the agent needs to serve static files (images, PDFs, screenshots,
  exported data) to the mycc WebUI for the user to preview or download. The
  Vite dev server in --serve mode serves <workdir>/.mycc/public/ at the root
  path "/", so any file placed in that directory is accessible at
  http://localhost:<port>/<filename>. Reference files in agent replies using
  markdown image syntax ![alt](/screenshot.png) for inline images, or
  markdown link syntax [label](/report.pdf) for download links. The directory
  is auto-created at server startup. Use this skill when generating visual
  artifacts, charts, PDFs, screenshots, or any file the user should view or
  download in the browser chat interface. Only available in --serve (WebUI)
  mode; the terminal TUI does not render images or links.
keywords: [serve, public, publicDir, static, assets, image, download, link, webui, vite, preview, screenshot, pdf, chart, file, serve-public-dir, markdown, inline, browser]
---

# Serve Public Dir — Static Files in the WebUI

## Purpose

When mycc runs in `--serve` mode (the WebUI), the Vite dev server serves a
**public directory** at the root path `/`. Any file the agent places in
`<workdir>/.mycc/public/` becomes accessible at
`http://localhost:<port>/<filename>` and can be **rendered inline** (images)
or **offered as a download link** (any file) inside the chat — the WebUI
renders agent replies with `markdown-it`, so standard markdown image and link
syntax become live `<img>` / `<a>` elements.

This skill teaches you how to leverage that mechanism so the user can
**preview and download** the artifacts you produce, instead of only reading
file paths in text.

## Where the Public Dir Lives

- **Path:** `<workdir>/.mycc/public/` — i.e. `.mycc/public/` relative to the
  current working directory mycc was launched from.
- **Lifecycle:** the directory is **auto-created at server startup** by
  `ServeHub.start()` via `fs.mkdirSync(..., { recursive: true })`, so it
  always exists by the time the Vite server boots. You do not need to create
  it, but creating it yourself (e.g. `New-Item -ItemType Directory -Force`)
  is harmless and useful if you want to write a file *before* the server has
  started.
- **Persistence:** files persist on disk across sessions — they are real
  files, not ephemeral. Clean them up if you no longer need them.
- **Mode:** only meaningful in `--serve` (WebUI) mode. In the terminal TUI,
  image/link markdown is shown as plain text and is not useful.

## URL Convention — Root-Absolute Paths

Files in `.mycc/public/` are served at the root `/`, so **always reference
them with a root-absolute URL** (leading slash, no `.mycc/public/` prefix):

| File on disk                         | URL in markdown        |
|--------------------------------------|------------------------|
| `.mycc/public/screenshot.png`        | `/screenshot.png`      |
| `.mycc/public/report.pdf`            | `/report.pdf`          |
| `.mycc/public/charts/q3-revenue.svg` | `/charts/q3-revenue.svg` |

**Do NOT** write `/.mycc/public/screenshot.png` or `./public/screenshot.png`
— those will 404. The public dir is the root; only the filename (with any
subfolder) follows the leading slash.

## How to Reference Files in Replies

The WebUI renders agent replies (`type:'result'` messages) with `markdown-it`
(`html:false`, `linkify:true`). Both image and link syntax are supported.

### Inline images

Use markdown image syntax — the image renders inside the chat bubble:

```markdown
Here is the chart from the analysis:

![Q3 revenue by region](/charts/q3-revenue.svg)
```

For a screenshot you captured (e.g. via the `screen` tool, saved into
`.mycc/public/`):

```markdown
![Current desktop state](/desktop-2026-09-18.png)
```

### Download links

Use markdown link syntax — the user gets a clickable link that the browser
serves (and downloads for non-inline types like `.pdf`, `.zip`, `.xlsx`):

```markdown
The full report is available for download:

[Download Q3 report (PDF)](/report.pdf)

And the raw data export:

[Download revenue.csv](/exports/revenue.csv)
```

### Direct URL

For completeness, the full URL (useful when telling the user to open it in a
new tab) is `http://localhost:<port>/<filename>`. You can read the port from
the startup banner or the `/config` endpoint; in most cases the
root-absolute markdown path is simpler and sufficient.

## Step-by-Step Usage Pattern

1. **Produce the file** with whatever tool generated it (`md-to-pdf`, a chart
   library, `screen`, an export script, etc.) and write the output to a path
   inside `.mycc/public/`. Use `bash` (`Copy-Item` / `cp` / `mv`) to move an
   existing file there if it was generated elsewhere:

   ```powershell
   Copy-Item .\out\report.pdf .\.mycc\public\report.pdf
   ```

   The folder already exists (auto-created at startup), so a plain copy is
   enough. If you are unsure, `New-Item -ItemType Directory -Force
   .\.mycc\public` is a safe no-op.

2. **Reference it in your reply** with root-absolute markdown:

   ```markdown
   I generated the Q3 report. Preview it below or download it:

   [Download Q3 report](/report.pdf)
   ```

   For an image, use `![alt](/file.png)` instead.

That is the whole workflow — place the file in the public dir, then point at
it with a root-absolute markdown URL.

## Example Scenarios

- **Screenshot preview** — capture via the `screen` tool, save the image to
  `.mycc/public/desktop.png`, reply with `![desktop](/desktop.png)`.
- **PDF report** — generate via `md-to-pdf`, copy the PDF to
  `.mycc/public/report.pdf`, reply with `[Download report](/report.pdf)`.
- **Chart image** — render a chart to `.mycc/public/charts/q3.svg`, reply
  with `![Q3 revenue](/charts/q3.svg)`.
- **Data export** — write a CSV/JSON to `.mycc/public/exports/data.csv`,
  reply with `[Download data.csv](/exports/data.csv)`.

## Notes & Pitfalls

- **Root-absolute only.** `/.mycc/public/foo.png` and `./public/foo.png` will
  404. Use `/foo.png`.
- **No transform / no hashing.** Files in the public dir are served **as-is**
  — the filename you write is the filename in the URL. There is no content
  hashing, so overwriting a file changes it live on the next request.
- **Folder is auto-created at startup.** `ServeHub.start()` runs
  `fs.mkdirSync(<cwd>/.mycc/public, { recursive: true })` before the Vite
  server boots, so the directory always exists. `restartServe()` re-runs
  `start()`, so a web UI restart keeps the public dir.
- **Subfolders are fine.** `.mycc/public/charts/q3.svg` is served at
  `/charts/q3.svg` — mirror the subfolder structure in the URL.
- **WebUI only.** This is meaningful in `--serve` mode. In the terminal TUI
  the markdown is shown as text, so prefer describing the file path instead.
- **File size.** There is no special upload limit for files *you* place on
  disk (the upload cap applies to files the user uploads *to* the agent, not
  to files the public dir serves). Use common sense — very large files will
  be slow to transfer over the loopback HTTP server.