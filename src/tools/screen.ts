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
 *   - Windows: PowerShell with .NET (System.Drawing)
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
  const isWin = platform === 'win32';

  // --- Display server ---
  let displayServer = 'unknown';
  const sessionType = process.env.XDG_SESSION_TYPE?.toLowerCase();
  if (sessionType === 'wayland' || process.env.WAYLAND_DISPLAY) {
    displayServer = 'wayland';
  } else if (sessionType === 'x11' || process.env.DISPLAY) {
    displayServer = 'x11';
  } else if (isWin) {
    displayServer = 'windows';
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
  const candidates = isWin
    ? ['powershell'] // Windows uses PowerShell with .NET
    : [
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
      const checkCmd = isWin ? `where ${cmd}` : `which ${cmd}`;
      execSync(checkCmd, {
        encoding: 'utf-8',
        timeout: 3000,
        ...(isWin ? { shell: 'cmd.exe' } : {}),
      });
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
 * On Windows, enumerate monitors via .NET and return a human-readable list
 * with 1-based indices and bounds. Used to (a) validate the requested
 * monitor index before capture and (b) produce an actionable error when
 * the index is out of range. Returns null if enumeration fails.
 */
function listWindowsMonitors(): string[] | null {
  const psScript =
    "$ProgressPreference='SilentlyContinue'; Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::AllScreens; $i=1; foreach($m in $s){ $b=$m.Bounds; Write-Output ('monitor[' + $i + '] primary=' + $m.Primary + ' bounds=' + $b.X + ',' + $b.Y + ',' + $b.Width + ',' + $b.Height); $i++ }";
  try {
    const out = execSync(`powershell -NoProfile -Command "${psScript}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
      shell: 'cmd.exe',
    });
    return out
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);
  } catch {
    return null;
  }
}

/**
 * Attempt to capture a screenshot, trying the best tool for the detected
 * environment first, then falling back through alternatives.
 *
 * @param monitorIndex 0-based array index into the OS monitor list
 *   (0 = primary). The handler converts the 1-based `desktop` input to
 *   this 0-based index. Out-of-range values are handled per-platform;
 *   on Windows an out-of-range index returns an error listing monitors.
 */
function captureScreenshot(
  env: DetectedEnv,
  screenshotPath: string,
  monitorIndex = 0,
): CaptureResult | CaptureError {
  // Build an ordered list of (command, description) to try
  const attempts: Array<{ cmd: string; desc: string }> = [];

  // --- Windows ---
  if (env.platform === 'win32') {
    const winPath = screenshotPath.replace(/\//g, '\\');
    // Use AllScreens indexing so a specific monitor can be captured on
    // multi-monitor setups. The source point must be the monitor's Bounds
    // origin (NOT Point.Empty), because a non-primary monitor's origin is
    // offset (e.g. 1920,0) in the virtual desktop coordinate space.
    const psScript = `
$ProgressPreference = 'SilentlyContinue';
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$screens = [System.Windows.Forms.Screen]::AllScreens;
$idx = ${monitorIndex};
if ($idx -lt 0 -or $idx -ge $screens.Length) {
  $list = ($screens | ForEach-Object { $b = $_.Bounds; $n = [Array]::IndexOf($screens,$_) + 1; 'monitor[' + $n + '] primary=' + $_.Primary + ' bounds=' + $b.X + ',' + $b.Y + ',' + $b.Width + ',' + $b.Height }) -join ' | ';
  [Console]::Error.Write('monitor index ' + ($idx + 1) + ' out of range (1..' + $screens.Length + '). ' + $list);
  exit 1;
}
$bounds = $screens[$idx].Bounds;
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height);
$graphics = [System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size);
$bitmap.Save('${winPath}')
`.trim().replace(/\n/g, ' ');
    attempts.push({ cmd: `powershell -NoProfile -Command "${psScript}"`, desc: `PowerShell/.NET (Windows built-in, monitor ${monitorIndex + 1})` });
  }

  // --- macOS ---
  if (env.platform === 'darwin') {
    // screencapture -D <display> is 1-based; monitorIndex is 0-based, so
    // monitorIndex + 1 == the 1-based desktop number the user passed in.
    const displayNum = monitorIndex + 1;
    attempts.push({ cmd: `screencapture -x -D ${displayNum} "${screenshotPath}"`, desc: `screencapture (macOS built-in, display ${displayNum})` });
  }

  // --- Linux + Wayland ---
  if (env.platform === 'linux' && env.displayServer === 'wayland') {
    if (env.desktop === 'gnome' || env.availableTools.includes('gnome-screenshot')) {
      attempts.push({ cmd: `gnome-screenshot -f "${screenshotPath}"`, desc: 'gnome-screenshot (GNOME/Wayland)' });
    }
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

  // --- Cross-desktop fallbacks ---
  if (env.availableTools.includes('spectacle') && !attempts.some(a => a.desc.includes('spectacle'))) {
    attempts.push({ cmd: `spectacle -b -n -o "${screenshotPath}"`, desc: 'spectacle (KDE)' });
  }
  if (env.availableTools.includes('gnome-screenshot') && !attempts.some(a => a.desc.includes('gnome-screenshot'))) {
    attempts.push({ cmd: `gnome-screenshot -f "${screenshotPath}"`, desc: 'gnome-screenshot (fallback)' });
  }

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
  const isWin = env.platform === 'win32';
  for (const attempt of attempts) {
    try {
      execSync(attempt.cmd, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: 'pipe',
        ...(isWin ? { shell: 'cmd.exe' } : {}),
      });
      if (fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 0) {
        return { ok: true, path: screenshotPath, method: attempt.desc };
      }
      failures.push(`${attempt.desc}: command ran but produced no output file`);
    } catch (err) {
      const e = err as Error & { stderr?: string };
      // Prefer stderr (PowerShell writes diagnostics there), then message.
      const detail = (e.stderr && e.stderr.trim()) || e.message;
      const msg = detail.split('\n')[0];
      failures.push(`${attempt.desc}: ${msg}`);
    }
  }

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

  if (env.platform === 'win32') {
    lines.push('  - Windows uses PowerShell with .NET (System.Drawing) for screenshots');
    lines.push('  - Ensure PowerShell is available in PATH');
  } else if (env.platform === 'darwin') {
    lines.push('  - macOS should have `screencapture` built-in');
  } else if (env.displayServer === 'wayland') {
    lines.push('  - Install gnome-screenshot: `sudo apt install gnome-screenshot`');
    lines.push('  - Or for wlroots (Sway/Hyprland): `sudo apt install grim`');
  } else if (env.displayServer === 'x11') {
    lines.push('  - Install scrot: `sudo apt install scrot`');
    lines.push('  - Or ImageMagick: `sudo apt install imagemagick`');
  } else {
    lines.push('  - Could not detect display server. Check that XDG_SESSION_TYPE is set.');
  }

  lines.push('');
  lines.push('**Manual alternatives:**');
  lines.push('  1. Take a screenshot manually and describe it');
  lines.push('  2. Use `bash` tool to read clipboard content');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const screenTool: ToolDefinition = {
  name: 'screen',
  description:
    'Capture a screenshot and use vision model to read/describe screen content. Use prompt parameter to ask specific questions about what is visible. On multi-monitor setups, use the desktop parameter to capture a SPECIFIC monitor (1-based: 1 = primary, 2 = second monitor, etc.); omit it to capture the primary monitor.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Custom prompt for the vision model. Use this to ask specific questions about the screen content (e.g., "What error message is shown?" or "Read the text in the terminal window").',
      },
      desktop: {
        type: 'number',
        description:
          'Which monitor to capture on a multi-monitor setup, given as a 1-based index (1 = primary monitor, 2 = second monitor, 3 = third, etc.). Omit or set to 1 to capture the primary monitor. On Windows this selects among [System.Windows.Forms.Screen]::AllScreens (internally converted to a 0-based array index); on macOS it maps directly to `screencapture -D <index>` (display number is 1-based). If the index is out of range, the tool lists the available monitors and their bounds so you can pick a valid one.',
      },
    },
    required: [],
  },
  scope: ['main', 'child'],

  handler: async (ctx: AgentContext, args: Record<string, unknown>): Promise<string> => {
    const customPrompt = (args.prompt as string) || DEFAULT_PROMPT;

    // Monitor selection (1-based; 1 = primary). Coerce to a positive
    // integer; invalid/non-numeric input falls back to the primary monitor.
    // `monitorIndex` below is the 0-based array index into AllScreens.
    let desktopNum = 1;
    if (args.desktop !== undefined && args.desktop !== null) {
      const n = Number(args.desktop);
      if (Number.isInteger(n) && n >= 1) {
        desktopNum = n;
      } else {
        ctx.core.brief('warn', 'screen', `Invalid desktop value "${args.desktop}" (expected positive integer, 1-based); falling back to primary monitor (1).`);
      }
    }
    const monitorIndex = desktopNum - 1; // 0-based for AllScreens indexing

    // Detect environment
    const env = detectEnvironment();
    ctx.core.brief('info', 'screen', `Environment: OS=${env.platform}, display=${env.displayServer}, desktop=${env.desktop}, monitor=${desktopNum}`);

    // On Windows, validate the monitor index up front so an out-of-range
    // value yields an actionable error listing the available monitors,
    // rather than a generic capture failure.
    if (env.platform === 'win32' && desktopNum > 1) {
      const monitors = listWindowsMonitors();
      if (monitors && desktopNum > monitors.length) {
        const list = monitors.join('\n');
        const msg = `Monitor index ${desktopNum} is out of range. ${monitors.length} monitor(s) detected:\n${list}\nUse a desktop value in 1..${monitors.length}.`;
        ctx.core.brief('error', 'screen', msg);
        return `## ❌ Invalid Monitor Index\n\n${msg}`;
      }
    }

    const tmpDir = os.tmpdir();
    const screenshotPath = path.join(tmpDir, `mycc_screen_${Date.now()}.png`);

    try {
      // Capture screenshot
      ctx.core.brief('info', 'screen', `Capturing screenshot (monitor ${desktopNum})`);

      const capture = captureScreenshot(env, screenshotPath, monitorIndex);

      if (!capture.ok) {
        ctx.core.brief('error', 'screen', capture.error);
        return `## ❌ Screenshot Capture Failed\n\n${capture.error}\n\n${capture.diagnostics}`;
      }

      ctx.core.brief('info', 'screen', `Captured via ${capture.method}`);

      // Describe via imgDescribe (handles resizing)
      const description = await ctx.core.imgDescribe(screenshotPath, customPrompt);
      return `## Screen Content\n\n${description}`;
    } catch (error: unknown) {
      const err = error as Error;
      ctx.core.brief('error', 'screen', err.message);
      return `## ❌ Screen Tool Error\n\n${err.message}`;
    } finally {
      // Cleanup
      try { fs.unlinkSync(screenshotPath); } catch { /* ignore */ }
    }
  },
};