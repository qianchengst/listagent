const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const IGNORED_TOPMOST_TITLES = new Set([
  'nvidia geforce overlay dt',
  'program manager',
  '桌面'
]);

function isIgnoredTopmostTitle(value) {
  const title = String(value || '').trim().toLowerCase();
  return IGNORED_TOPMOST_TITLES.has(title)
    || title.includes('wallpaper engine')
    || title.includes('lively wallpaper');
}

const TOPMOST_WINDOW_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class TopmostWindowInfo {
  public int X { get; set; }
  public int Y { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
  public int ProcessId { get; set; }
  public string Title { get; set; }
}

public static class TopmostWindowInspector {
  private const int GWL_EXSTYLE = -20;
  private const long WS_EX_TOPMOST = 0x00000008L;

  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  private static bool IsIgnoredTitle(string title) {
    var value = (title ?? string.Empty).Trim();
    return value.Equals("NVIDIA GeForce Overlay DT", StringComparison.OrdinalIgnoreCase)
      || value.Equals("Program Manager", StringComparison.OrdinalIgnoreCase)
      || value.Equals("桌面", StringComparison.OrdinalIgnoreCase)
      || value.IndexOf("Wallpaper Engine", StringComparison.OrdinalIgnoreCase) >= 0
      || value.IndexOf("Lively Wallpaper", StringComparison.OrdinalIgnoreCase) >= 0;
  }

  private static bool IsIgnoredProcess(uint processId) {
    try {
      var processName = Process.GetProcessById((int)processId).ProcessName;
      return processName.Equals("wallpaper64", StringComparison.OrdinalIgnoreCase)
        || processName.Equals("wallpaper32", StringComparison.OrdinalIgnoreCase)
        || processName.Equals("wallpaperservice32", StringComparison.OrdinalIgnoreCase)
        || processName.Equals("webpiclaunch", StringComparison.OrdinalIgnoreCase)
        || processName.Equals("livelyw", StringComparison.OrdinalIgnoreCase)
        || processName.Equals("livelywallpaper", StringComparison.OrdinalIgnoreCase);
    } catch {
      return false;
    }
  }

  private static bool IsIgnoredWindow(IntPtr hWnd, uint processId, string title) {
    if (IsIgnoredTitle(title) || IsIgnoredProcess(processId)) return true;
    var className = new StringBuilder(256);
    GetClassName(hWnd, className, className.Capacity);
    var value = className.ToString();
    // Wallpaper/shell surfaces can expose a visible window even when no app is
    // open. They are not valid perch targets.
    return value.Equals("WorkerW", StringComparison.OrdinalIgnoreCase)
      || value.Equals("Progman", StringComparison.OrdinalIgnoreCase)
      || value.Equals("SHELLDLL_DefView", StringComparison.OrdinalIgnoreCase);
  }

  public static TopmostWindowInfo[] Find(int ownProcessId) {
    var windows = new List<TopmostWindowInfo>();
    TopmostWindowInfo foregroundWindow = null;
    IntPtr foregroundHandle = GetForegroundWindow();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd) || IsIconic(hWnd) || IsZoomed(hWnd)) return true;
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      if (processId == ownProcessId) return true;
      long exStyle = GetWindowLongPtr(hWnd, GWL_EXSTYLE).ToInt64();
      int titleLength = GetWindowTextLength(hWnd);
      if (titleLength == 0) return true;
      RECT rect;
      if (!GetWindowRect(hWnd, out rect)) return true;
      int width = rect.Right - rect.Left;
      int height = rect.Bottom - rect.Top;
      if (width < 160 || height < 80) return true;
      var title = new StringBuilder(titleLength + 1);
      GetWindowText(hWnd, title, title.Capacity);
      var titleValue = title.ToString();
      if (IsIgnoredWindow(hWnd, processId, titleValue)) return true;
      var info = new TopmostWindowInfo {
        X = rect.Left,
        Y = rect.Top,
        Width = width,
        Height = height,
        ProcessId = (int)processId,
        Title = titleValue
      };
      if ((exStyle & WS_EX_TOPMOST) != 0) windows.Add(info);
      else if (hWnd == foregroundHandle) foregroundWindow = info;
      return true;
    }, IntPtr.Zero);
    // Only the actual foreground application is a valid non-topmost fallback.
    // The previous first-window fallback could mistake Wallpaper Engine's
    // desktop surface (or another background helper) for an open application.
    if (windows.Count == 0 && foregroundWindow != null) windows.Add(foregroundWindow);
    return windows.ToArray();
  }
}
'@
`;

function normalizeWindows(value) {
  const candidates = Array.isArray(value) ? value : value ? [value] : [];
  return candidates
    .map((item) => ({
      x: Number(item.X),
      y: Number(item.Y),
      width: Number(item.Width),
      height: Number(item.Height),
      processId: Number(item.ProcessId),
      title: typeof item.Title === 'string' ? item.Title : ''
    }))
    .filter((item) => !isIgnoredTopmostTitle(item.title))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && item.width >= 160 && item.height >= 80);
}

async function findTopmostUnmaximizedWindows(ownProcessId) {
  const safeProcessId = Number.isInteger(Number(ownProcessId)) ? Number(ownProcessId) : 0;
  const command = `${TOPMOST_WINDOW_SCRIPT}\n@([TopmostWindowInspector]::Find(${safeProcessId})) | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    return normalizeWindows(JSON.parse(stdout.trim() || '[]'));
  } catch {
    // Window perching is optional; failure to inspect native windows must not stop the pet.
    return [];
  }
}

module.exports = { findTopmostUnmaximizedWindows, normalizeWindows, isIgnoredTopmostTitle };
