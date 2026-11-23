param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('focus-and-position', 'untopmost', 'type-text', 'press-key', 'capture')]
  [string]$Action,

  [string]$TitleMatch = '',
  [long]$Hwnd = 0,
  [int]$X = 100,
  [int]$Y = 80,
  [int]$Width = 1280,
  [int]$Height = 800,
  [string]$Text = '',
  [int]$DelayMs = 55,
  [switch]$PressEnter,
  [string]$Key = '',
  [string]$FfmpegPath = '',
  [string]$OutFile = '',
  [string]$StopFile = '',
  [int]$Fps = 12,
  [int]$CropTop = 36
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies @('System.Drawing') -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Win32DemoHelper {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const int SW_RESTORE = 9;

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

  public const uint PW_RENDERFULLCONTENT = 0x00000002;

  public static int CaptureWindowToMp4(IntPtr hwnd, string ffmpegPath, string outFile, string stopFile, int fps, int cropTop) {
    RECT winRect;
    if (!GetWindowRect(hwnd, out winRect)) throw new Exception("GetWindowRect failed");
    int winW = winRect.Right - winRect.Left;
    int winH = winRect.Bottom - winRect.Top;

    RECT dwmRect;
    int hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out dwmRect, Marshal.SizeOf(typeof(RECT)));
    if (hr != 0) dwmRect = winRect;

    int cropX = Math.Max(0, dwmRect.Left - winRect.Left);
    int cropY = Math.Max(0, (dwmRect.Top - winRect.Top) + cropTop);
    int cropW = ((Math.Min(winW - cropX, dwmRect.Right - dwmRect.Left)) / 2) * 2;
    int cropH = ((Math.Min(winH - cropY, (dwmRect.Bottom - dwmRect.Top) - cropTop)) / 2) * 2;

    var psi = new ProcessStartInfo();
    psi.FileName = ffmpegPath;
    psi.Arguments = string.Format(
      "-y -f rawvideo -pixel_format bgra -video_size {0}x{1} -framerate {2} -i - -vf crop={3}:{4}:{5}:{6} -c:v libx264 -preset ultrafast -crf 10 -pix_fmt yuv420p \"{7}\"",
      winW, winH, fps, cropW, cropH, cropX, cropY, outFile
    );
    psi.UseShellExecute = false;
    psi.RedirectStandardInput = true;
    psi.RedirectStandardError = true;
    psi.CreateNoWindow = true;

    using (var proc = Process.Start(psi)) {
      var errBuilder = new StringBuilder();
      proc.ErrorDataReceived += (s, e) => { if (e.Data != null) errBuilder.AppendLine(e.Data); };
      proc.BeginErrorReadLine();

      int byteLen = winW * winH * 4;
      byte[] buffer = new byte[byteLen];
      double frameMs = 1000.0 / fps;
      int frames = 0;

      using (var bmp = new Bitmap(winW, winH, PixelFormat.Format32bppArgb)) {
        var sw = Stopwatch.StartNew();
        var stdin = proc.StandardInput.BaseStream;
        while (!File.Exists(stopFile)) {
          double targetMs = frames * frameMs;
          double waitMs = targetMs - sw.Elapsed.TotalMilliseconds;
          if (waitMs > 2) Thread.Sleep((int)waitMs);

          using (var g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            try {
              PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT);
            } finally {
              g.ReleaseHdc(hdc);
            }
          }

          var bd = bmp.LockBits(new Rectangle(0, 0, winW, winH), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
          try {
            Marshal.Copy(bd.Scan0, buffer, 0, byteLen);
          } finally {
            bmp.UnlockBits(bd);
          }
          stdin.Write(buffer, 0, byteLen);
          frames++;
        }
        stdin.Flush();
        stdin.Close();
      }

      proc.WaitForExit(15000);
      if (proc.ExitCode != 0) {
        throw new Exception("ffmpeg exited " + proc.ExitCode + ": " + errBuilder.ToString());
      }
      return frames;
    }
  }

  public static bool ForceForeground(IntPtr hWnd) {
    if (GetForegroundWindow() == hWnd) return true;
    IntPtr fg = GetForegroundWindow();
    uint dummy;
    uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out dummy) : 0;
    uint targetThread = GetWindowThreadProcessId(hWnd, out dummy);
    uint curThread = GetCurrentThreadId();

    if (fgThread != 0 && fgThread != curThread) AttachThreadInput(curThread, fgThread, true);
    if (targetThread != 0 && targetThread != curThread) AttachThreadInput(curThread, targetThread, true);
    try {
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
    } finally {
      if (targetThread != 0 && targetThread != curThread) AttachThreadInput(curThread, targetThread, false);
      if (fgThread != 0 && fgThread != curThread) AttachThreadInput(curThread, fgThread, false);
    }
    return GetForegroundWindow() == hWnd;
  }

  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

  public static IntPtr FindWindowByTitle(string substr) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      int len = GetWindowTextLength(hWnd);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (title.IndexOf(substr, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void SendUnicodeChar(char c) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].U.ki.wVk = 0;
    inputs[0].U.ki.wScan = (ushort)c;
    inputs[0].U.ki.dwFlags = KEYEVENTF_UNICODE;

    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].U.ki.wVk = 0;
    inputs[1].U.ki.wScan = (ushort)c;
    inputs[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;

    SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void SendVirtualKey(ushort vk) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].U.ki.wVk = vk;
    inputs[0].U.ki.dwFlags = 0;

    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].U.ki.wVk = vk;
    inputs[1].U.ki.dwFlags = KEYEVENTF_KEYUP;

    SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@

function Resolve-TargetHwnd {
  if ($Hwnd -ne 0) {
    return [IntPtr]$Hwnd
  }
  if (-not $TitleMatch) {
    throw "Either -Hwnd or -TitleMatch must be provided."
  }
  for ($i = 0; $i -lt 40; $i++) {
    $h = [Win32DemoHelper]::FindWindowByTitle($TitleMatch)
    if ($h -ne [IntPtr]::Zero) {
      return $h
    }
    Start-Sleep -Milliseconds 150
  }
  throw "Could not find visible window matching title '$TitleMatch'."
}

switch ($Action) {
  'focus-and-position' {
    $target = Resolve-TargetHwnd
    [Win32DemoHelper]::ShowWindow($target, [Win32DemoHelper]::SW_RESTORE) | Out-Null
    [Win32DemoHelper]::SetWindowPos($target, [Win32DemoHelper]::HWND_TOPMOST, $X, $Y, $Width, $Height, [Win32DemoHelper]::SWP_SHOWWINDOW) | Out-Null
    $isFg = [Win32DemoHelper]::ForceForeground($target)
    Start-Sleep -Milliseconds 250

    $rect = New-Object Win32DemoHelper+RECT
    $hr = [Win32DemoHelper]::DwmGetWindowAttribute($target, [Win32DemoHelper]::DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect))
    if ($hr -ne 0) {
      [Win32DemoHelper]::GetWindowRect($target, [ref]$rect) | Out-Null
    }

    $clientRect = New-Object Win32DemoHelper+RECT
    [Win32DemoHelper]::GetClientRect($target, [ref]$clientRect) | Out-Null
    $origin = New-Object Win32DemoHelper+POINT
    $origin.X = 0
    $origin.Y = 0
    [Win32DemoHelper]::ClientToScreen($target, [ref]$origin) | Out-Null

    $result = @{
      hwnd = $target.ToInt64()
      isForeground = $isFg
      left = $rect.Left
      top = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
      clientLeft = $origin.X
      clientTop = $origin.Y
      clientWidth = $clientRect.Right - $clientRect.Left
      clientHeight = $clientRect.Bottom - $clientRect.Top
    }
    $result | ConvertTo-Json -Compress
  }
  'untopmost' {
    if ($Hwnd -ne 0) {
      $target = [IntPtr]$Hwnd
      [Win32DemoHelper]::SetWindowPos($target, [Win32DemoHelper]::HWND_NOTOPMOST, 0, 0, 0, 0, [Win32DemoHelper]::SWP_NOMOVE -bor [Win32DemoHelper]::SWP_NOSIZE -bor [Win32DemoHelper]::SWP_NOACTIVATE) | Out-Null
    }
  }
  'type-text' {
    if ($Hwnd -ne 0) {
      [Win32DemoHelper]::ForceForeground([IntPtr]$Hwnd) | Out-Null
      Start-Sleep -Milliseconds 80
    }
    foreach ($ch in $Text.ToCharArray()) {
      [Win32DemoHelper]::SendUnicodeChar($ch)
      if ($DelayMs -gt 0) {
        Start-Sleep -Milliseconds $DelayMs
      }
    }
    if ($PressEnter) {
      Start-Sleep -Milliseconds 250
      [Win32DemoHelper]::SendVirtualKey(0x0D)
    }
  }
  'press-key' {
    if ($Hwnd -ne 0) {
      [Win32DemoHelper]::ForceForeground([IntPtr]$Hwnd) | Out-Null
      Start-Sleep -Milliseconds 60
    }
    $vkMap = @{
      'Enter' = 0x0D
      'Escape' = 0x1B
      'Backspace' = 0x08
      'Delete' = 0x2E
      'F2' = 0x71
      'Tab' = 0x09
      'Up' = 0x26
      'Down' = 0x28
    }
    if (-not $vkMap.ContainsKey($Key)) {
      throw "Unsupported key: $Key"
    }
    [Win32DemoHelper]::SendVirtualKey([uint16]$vkMap[$Key])
  }
  'capture' {
    $target = Resolve-TargetHwnd
    $frames = [Win32DemoHelper]::CaptureWindowToMp4($target, $FfmpegPath, $OutFile, $StopFile, $Fps, $CropTop)
    @{ frames = $frames } | ConvertTo-Json -Compress
  }
}
