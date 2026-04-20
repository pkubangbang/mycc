/**
 * screen.ts - Screen reader tool: captures a screenshot and uses a vision model
 * to read/describe the content on screen.
 *
 * Detects the OS, display server (Wayland/X11), and available screenshot tools
 * to select the best capture method. Falls back through alternatives, and
 * produces detailed diagnostics on failure so the LLM can guide the user
 * toward manual alternatives.
 *
 * Supported environments:
 *   - Linux + Wayland/GNOME: gnome-screenshot
 *   - Linux + Wayland/wlroots (Sway, Hyprland): grim
 *   - Linux + X11: scrot, import (ImageMagick), gnome-screenshot
 *   - macOS: screencapture (built-in)
 *
 * Scope: ['main', 'child'] - Available to lead and teammate agents
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDefinition, AgentContext } from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default prompt for screen reading */
const DEFAULT_PROMPT =
  'You are a screen reader. Carefully examine this screenshot and describe all visible content in detail. Include: text content, UI elements, window titles, buttons, menus, icons, any open applications, and the overall layout. Be thorough and precise.';

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

interface DetectedEnv {
  platform: string;       // 'linux' | 'darwin' | 'win32' | 'unknown'
  displayServer: string;  // 'wayland' | 'x11' | 'unknown'
  desktop: string;        // 'gnome' | 'kde' | 'sway' | 'hyprland' | 'unknown'
  availableTools: string[];// screenshot commands found on $PATH
}

/**
 * Detect the runtime environment: OS, display server, desktop compositor,
 * and which screenshot tools are installed.
 */
function detectEnvironment(): DetectedEnv {
  const platform = os.platform();

  // --- Display server ---
  let displayServer = 'unknown';
  const sessionType = process.env.XDG_SESSION_TYPE?.toLowerCase();
  if (sessionType === 'wayland' || process.env.WAYLAND_DISPLAY) {
    displayServer = 'wayland';
  } else if (sessionType === 'x11' || process.env.DISPLAY) {
    displayServer = 'x11';
  }

  // --- Desktop / compositor ---
  let desktop = 'unknown';
  const desktopSession = (process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase();
  const sessionDesktop = (process.env.XDG_SESSION_DESKTOP ?? '').toLowerCase();
  if (desktopSession.includes('gnome') || sessionDesktop.includes('gnome')) {
    desktop = 'gnome';
  } else if (desktopSession.includes('kde') || sessionDesktop.includes('kde') || sessionDesktop.includes('plasma')) {
    desktop = 'kde';
  } else if (desktopSession.includes('sway') || sessionDesktop.includes('sway')) {
    desktop = 'sway';
  } else if (desktopSession.includes('hyprland') || sessionDesktop.includes('hyprland')) {
    desktop = 'hyprland';
  }

  // --- Available screenshot tools ---
  const candidates = [
    'gnome-screenshot',   // GNOME / Wayland or X11
    'grim',               // wlroots compositors (Sway, Hyprland)
    'spectacle',          // KDE
    'scrot',              // X11 lightweight
    'import',             // ImageMagick (X11)
    'screencapture',      // macOS built-in
  ];

  const availableTools: string[] = [];
  for (const cmd of candidates) {
    try {
      execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
      availableTools.push(cmd);
    } catch {
      // not found
    }
  }

  return { platform, displayServer, desktop, availableTools };
}

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------

interface CaptureResult {
  ok: true;
  path: string;
  method: string;
}

interface CaptureError {
  ok: false;
  error: string;
  diagnostics: string;
}

/**
 * Attempt to capture a screenshot, trying the best tool for the detected
 * environment first, then falling back through alternatives.
 */
function captureScreenshot(
  env: DetectedEnv,
  screenshotPath: string,
): CaptureResult | CaptureError {
  // Build an ordered list of (command, description) to try
  const attempts: Array<{ cmd: string; desc: string }> = [];

  // --- macOS ---
  if (env.platform === 'darwin') {
    attempts.push({ cmd: `screencapture -x "${screenshotPath}"`, desc: 'screencapture (macOS built-in)' });
  }

  // --- Linux + Wayland ---
  if (env.platform === 'linux' && env.displayServer === 'wayland') {
    // GNOME on Wayland → gnome-screenshot is the reliable choice
    if (env.desktop === 'gnome' || env.availableTools.includes('gnome-screenshot')) {
      attempts.push({ cmd: `gnome-screenshot -f "${screenshotPath}"`, desc: 'gnome-screenshot (GNOME/Wayland)' });
    }
    // wlroots compositors (Sway, Hyprland) → grim
    if (env.desktop === 'sway' || env.desktop === 'hyprland' || env.availableTools.includes('grim')) {
      attempts.push({ cmd: `grim "${screenshotPath}"`, desc: 'grim (wlroots/Wayland)' });
    }
  }

  // --- Linux + X11 ---
  if (env.platform === 'linux' && env.displayServer === 'x11') {
    if (env.availableTools.includes('gnome-screenshot')) {
      attempts.push({ cmd: `gnome-screenshot -f "${screenshotPath}"`, desc: 'gnome-screenshot (X11)' });
    }
    if (env.availableTools.includes('scrot')) {
      attempts.push({ cmd: `scrot "${screenshotPath}"`, desc: 'scrot (X11)' });
    }
    if (env.availableTools.includes('import')) {
      attempts.push({ cmd: `import -window root "${screenshotPath}"`, desc: 'import/ImageMagick (X11)' });
    }
  }

  // --- Cross-desktop fallbacks (any display server) ---
  if (env.availableTools.includes('spectacle') && !attempts.some(a => a.desc.includes('spectacle'))) {
    attempts.push({ cmd: `spectacle -b -n -o "${screenshotPath}"`, desc: 'spectacle (KDE)' });
  }
  if (env.availableTools.includes('gnome-screenshot') && !attempts.some(a => a.desc.includes('gnome-screenshot'))) {
    attempts.push({ cmd: `gnome-screenshot -f "${screenshotPath}"`, desc: 'gnome-screenshot (fallback)' });
  }

  // If no tools matched at all, report detailed diagnostics
  if (attempts.length === 0) {
    const diagnostics = buildDiagnostics(env, []);
    return {
      ok: false,
      error: `No compatible screenshot tool found for this environment (OS: ${env.platform}, display: ${env.displayServer}, desktop: ${env.desktop}).`,
      diagnostics,
    };
  }

  // Try each method in priority order
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      execSync(attempt.cmd, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
      if (fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 0) {
        return { ok: true, path: screenshotPath, method: attempt.desc };
      }
      failures.push(`${attempt.desc}: command ran but produced no output file`);
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0]; // first line only
      failures.push(`${attempt.desc}: ${msg}`);
    }
  }

  // All attempts failed
  const diagnostics = buildDiagnostics(env, failures);
  return {
    ok: false,
    error: `All screenshot capture methods failed (tried ${failures.length} method(s)).`,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics & user guidance
// ---------------------------------------------------------------------------

/**
 * Build a detailed diagnostics string to help the LLM guide the user
 * toward fixing the issue or finding a manual alternative.
 */
function buildDiagnostics(env: DetectedEnv, failures: string[]): string {
  const lines: string[] = [];

  lines.push('**Screen Tool Diagnostics**');
  lines.push('');
  lines.push(`- **OS:** ${env.platform}`);
  lines.push(`- **Display server:** ${env.displayServer}`);
  lines.push(`- **Desktop/compositor:** ${env.desktop}`);
  lines.push(`- **Screenshot tools found:** ${env.availableTools.length > 0 ? env.availableTools.join(', ') : 'none'}`);
  lines.push('');

  if (failures.length > 0) {
    lines.push('**Capture attempts:**');
    for (const f of failures) {
      lines.push(`  - ❌ ${f}`);
    }
    lines.push('');
  }

  lines.push('**Suggested fixes:**');

  if (env.platform === 'darwin') {
    lines.push('  - macOS should have `screencapture` built-in');
    lines.push('  - Check that the tool is in your $PATH');
  } else if (env.displayServer === 'wayland') {
    if (env.desktop === 'gnome' || env.desktop === 'unknown') {
      lines.push('  - Install gnome-screenshot: `sudo apt install gnome-screenshot`');
    }
    if (env.desktop === 'sway' || env.desktop === 'hyprland') {
      lines.push('  - Install grim: `sudo apt install grim` (or your distro equivalent)');
    }
    if (env.desktop === 'unknown') {
      lines.push('  - For GNOME on Wayland: `sudo apt install gnome-screenshot`');
      lines.push('  - For wlroots (Sway/Hyprland): `sudo apt install grim`');
    }
    lines.push('  - Note: scrot and ImageMagick `import` do NOT work on Wayland');
  } else if (env.displayServer === 'x11') {
    lines.push('  - Install scrot: `sudo apt install scrot`');
    lines.push('  - Or ImageMagick: `sudo apt install imagemagick`');
    lines.push('  - Or gnome-screenshot: `sudo apt install gnome-screenshot`');
  } else {
    lines.push('  - Could not detect display server. Check that XDG_SESSION_TYPE is set.');
    lines.push('  - For Wayland: install gnome-screenshot or grim');
    lines.push('  - For X11: install scrot or imagemagick');
  }

  lines.push('');
  lines.push('**Manual alternatives for the user:**');
  lines.push('  1. Take a screenshot manually (Print Screen key, or screenshot app) and save it to a file');
  lines.push('  2. Use the `bash` tool to read specific text content from the screen (e.g., `wl-paste` or `xclip -selection clipboard -o` for clipboard text)');
  lines.push('  3. If a browser is open, ask the user to share the URL and use `web_fetch` instead');
  lines.push('  4. Copy visible text to the clipboard and use `bash` with `xclip`/`wl-paste` to retrieve it');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Image preprocessing
// ---------------------------------------------------------------------------

/**
 * Optionally crop and/or resize the screenshot for efficient API transport.
 * Returns the path to the final image (may differ from input if processing
 * was applied).
 */
function preprocessImage(
  ctx: AgentContext,
  screenshotPath: string,
  region?: string,
): string {
  const tmpDir = os.tmpdir();
  const processedPath = path.join(tmpDir, `mycc_screen_processed_${Date.now()}.png`);

  // Crop if a region was specified
  if (region) {
    try {
      execSync(`convert "${screenshotPath}" -crop ${region} "${processedPath}"`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: 'pipe',
      });
      ctx.core.brief('info', 'screen', `Cropped to region: ${region}`);
      return processedPath;
    } catch (err) {
      ctx.core.brief('warn', 'screen', `Crop failed, using full screenshot: ${(err as Error).message}`);
    }
  }

  // Resize if wider than 1280px (keeps base64 payload manageable)
  try {
    const sizeInfo = execSync(`identify -format "%w %h" "${screenshotPath}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    }).trim();
    const [width] = sizeInfo.split(' ').map(Number);
    if (width > 1280) {
      execSync(`convert "${screenshotPath}" -resize 1280x "${processedPath}"`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: 'pipe',
      });
      ctx.core.brief('info', 'screen', `Resized from ${width}px to 1280px wide`);
      return processedPath;
    }
  } catch {
    ctx.core.brief('warn', 'screen', 'Resize skipped (ImageMagick not available), using original screenshot');
  }

  return screenshotPath;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const screenTool: ToolDefinition = {
  name: 'screen',
  description: 'Capture a screenshot and use vision model to read/describe screen content. Use prompt parameter to ask specific questions about what is visible.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Custom prompt for the vision model. Use this to ask specific questions about the screen content (e.g., "What error message is shown?" or "Read the text in the terminal window").',
      },
      region: {
        type: 'string',
        description:
          'Crop region as WxH+X+Y (e.g., "800x600+100+200"). If omitted, captures the full screen.',
      },
    },
    required: [],
  },
  scope: ['main', 'child'],

  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const customPrompt = (args.prompt as string) || DEFAULT_PROMPT;
    const region = args.region as string | undefined;

    // --- Step 0: Detect environment ---
    const env = detectEnvironment();
    ctx.core.brief('info', 'screen', `Environment: OS=${env.platform}, display=${env.displayServer}, desktop=${env.desktop}, tools=[${env.availableTools.join(', ')}]`);

    const tmpDir = os.tmpdir();
    const screenshotPath = path.join(tmpDir, `mycc_screen_${Date.now()}.png`);
    let processedPath: string | undefined;

    try {
      // --- Step 1: Capture screenshot ---
      ctx.core.brief('info', 'screen', `Capturing screenshot${region ? ` (region: ${region})` : ' (full screen)'}`);

      const capture = captureScreenshot(env, screenshotPath);

      if (!capture.ok) {
        ctx.core.brief('error', 'screen', capture.error);
        return `## ❌ Screenshot Capture Failed\n\n${capture.error}\n\n${capture.diagnostics}`;
      }

      ctx.core.brief('info', 'screen', `Captured via ${capture.method}`);
      ctx.core.brief('info', 'screen', `Screenshot saved: ${screenshotPath}`);

      // --- Step 2: Preprocess (crop/resize) ---
      const finalPath = preprocessImage(ctx, screenshotPath, region);
      processedPath = finalPath !== screenshotPath ? finalPath : undefined;

      // --- Step 3: Base64 encode ---
      const imageBuffer = fs.readFileSync(finalPath);
      const base64Image = imageBuffer.toString('base64');

      ctx.core.brief('info', 'screen', `Image: ${imageBuffer.length} bytes, base64: ${base64Image.length} chars`);

      // --- Step 4: Describe via core.imgDescribe ---
      try {
        const description = await ctx.core.imgDescribe(base64Image, customPrompt);
        return `## Screen Content\n\n${description}`;
      } catch (err) {
        const errMsg = (err as Error).message;
        ctx.core.brief('error', 'screen', `Vision model error: ${errMsg}`);
        return `## ❌ Vision Model Failed\n\n${errMsg}\n\n**Fallback alternatives:**\n  - Ask the user to describe the screen content manually\n  - If a browser is visible, get the URL and use \`web_fetch\` instead\n  - Copy on-screen text to clipboard and read it with \`bash\` + \`wl-paste\`/ \`xclip\``;
      }
    } finally {
      // Cleanup temp files
      try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
      if (processedPath) {
        try { fs.unlinkSync(processedPath); } catch { /* ignore */ }
      }
    }
  },
};