const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const IGNORED_TOPMOST_TITLES = new Set(['nvidia geforce overlay dt']);

const TOPMOST_WINDOW_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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
  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  public static TopmostWindowInfo[] Find(int ownProcessId) {
    var windows = new List<TopmostWindowInfo>();
    TopmostWindowInfo fallbackWindow = null;
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
      if (title.ToString().Trim().Equals("NVIDIA GeForce Overlay DT", StringComparison.OrdinalIgnoreCase)) return true;
      var info = new TopmostWindowInfo {
        X = rect.Left,
        Y = rect.Top,
        Width = width,
        Height = height,
        ProcessId = (int)processId,
        Title = title.ToString()
      };
      if ((exStyle & WS_EX_TOPMOST) != 0) windows.Add(info);
      else if (fallbackWindow == null) fallbackWindow = info;
      return true;
    }, IntPtr.Zero);
    // Some applications expose a visible, unmaximized foreground window but
    // do not set WS_EX_TOPMOST.  Use it as a safe fallback when no eligible
    // always-on-top window remains (for example, when only NVIDIA Overlay was
    // detected).  The caller's own process is still excluded.
    if (windows.Count == 0 && fallbackWindow != null) {
      windows.Add(fallbackWindow);
    }
    if (windows.Count == 0) {
      IntPtr hWnd = GetForegroundWindow();
      if (hWnd != IntPtr.Zero && IsWindowVisible(hWnd) && !IsIconic(hWnd) && !IsZoomed(hWnd)) {
        uint processId;
        GetWindowThreadProcessId(hWnd, out processId);
        int titleLength = GetWindowTextLength(hWnd);
        RECT rect;
        if (processId != ownProcessId && titleLength > 0 && GetWindowRect(hWnd, out rect)) {
          int width = rect.Right - rect.Left;
          int height = rect.Bottom - rect.Top;
          var title = new StringBuilder(titleLength + 1);
          GetWindowText(hWnd, title, title.Capacity);
          if (width >= 160 && height >= 80 && !title.ToString().Trim().Equals("NVIDIA GeForce Overlay DT", StringComparison.OrdinalIgnoreCase)) {
            windows.Add(new TopmostWindowInfo {
              X = rect.Left,
              Y = rect.Top,
              Width = width,
              Height = height,
              ProcessId = (int)processId,
              Title = title.ToString()
            });
          }
        }
      }
    }
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
    .filter((item) => !IGNORED_TOPMOST_TITLES.has(item.title.trim().toLowerCase()))
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

module.exports = { findTopmostUnmaximizedWindows, normalizeWindows };
