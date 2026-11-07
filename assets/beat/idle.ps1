# idle.ps1 - 只输出一个数字：键盘/鼠标闲置秒数。
# 隐私边界：不读窗口标题、不读进程、不读屏幕内容。
param([string]$out)

$ErrorActionPreference = 'Stop'
if (-not $out) { throw 'idle.ps1: -out <path> is required' }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WhaleIdleProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static long IdleSeconds() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    if (!GetLastInputInfo(ref li)) return -1;
    long tick = Environment.TickCount & 0x7FFFFFFF;
    long last = li.dwTime & 0x7FFFFFFF;
    return tick >= last ? (tick - last) / 1000 : 0;
  }
}
'@

$idle = [WhaleIdleProbe]::IdleSeconds()
[IO.File]::WriteAllText($out, $idle.ToString())
