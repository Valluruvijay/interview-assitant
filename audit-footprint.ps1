# Footprint audit for InterviewAI Pro (read-only).
# Reports exactly what a proctoring agent running on this machine could observe
# about the app: processes, top-level windows, shell presence, audio devices
# and outbound connections. It changes nothing.

param(
  [string]$ProcessName = 'AMD Audio Service'
)

Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Text;using System.Collections.Generic;
public class Aud {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static int Ex(IntPtr h) { return GetWindowLong(h, -20); }
}
'@

function Flags([int]$ex) {
  $f = @()
  if ($ex -band 0x00000008) { $f += 'TOPMOST' }
  if ($ex -band 0x00008000) { $f += 'TOOLWINDOW(no taskbar/alt-tab)' }
  if ($ex -band 0x00040000) { $f += 'TRANSPARENT(click-through)' }
  if ($ex -band 0x00080000) { $f += 'LAYERED' }
  if ($ex -band 0x08000000) { $f += 'NOACTIVATE(never steals focus)' }
  if ($ex -band 0x00000020) { $f += 'APPWINDOW(taskbar entry)' }
  if (-not $f.Count) { $f += 'none' }
  return ($f -join ', ')
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  InterviewAI Pro - observable footprint audit" -ForegroundColor Cyan
Write-Host "  (what a proctoring agent on this machine could see)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# ---------- 1. processes ----------
Write-Host "`n[1] PROCESS LIST (visible to tasklist / Process Explorer / Get-Process)" -ForegroundColor Yellow
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -like "*$ProcessName*" -or ($_.Name -like "electron*" -and $_.CommandLine -like '*interview assitant*')
}
if (-not $procs) { Write-Host "  (app is not running)" -ForegroundColor DarkGray }
foreach ($p in $procs) {
  $exe = if ($p.ExecutablePath) { $p.ExecutablePath } else { '(path not readable without elevation)' }
  Write-Host ("  pid={0,-6} name={1,-22} exe={2}" -f $p.ProcessId, $p.Name, $exe) -ForegroundColor White
}

# ---------- 2. top level windows ----------
Write-Host "`n[2] TOP-LEVEL WINDOWS (visible to EnumWindows / UI Automation)" -ForegroundColor Yellow
$pids = @($procs | ForEach-Object { [uint32]$_.ProcessId })
$fg = [Aud]::GetForegroundWindow()
$wins = New-Object System.Collections.ArrayList
[Aud]::EnumWindows({
  param($h, $l)
  if ([Aud]::Pid($h) -in $pids) {
    $r = New-Object Aud+RECT
    [void][Aud]::GetWindowRect($h, [ref]$r)
    [void]$wins.Add([pscustomobject]@{
      Hwnd = $h; Vis = [Aud]::IsWindowVisible($h); Title = [Aud]::Title($h); Cls = [Aud]::Cls($h)
      Rect = "$($r.Left),$($r.Top) -> $($r.Right),$($r.Bottom)"; Ex = [Aud]::Ex($h); Fg = ($h -eq $fg)
    })
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if (-not $wins.Count) { Write-Host "  (no top-level windows)" -ForegroundColor DarkGray }
foreach ($w in $wins) {
  Write-Host ("  hwnd={0} visible={1} foreground={2}" -f $w.Hwnd, $w.Vis, $w.Fg) -ForegroundColor White
  Write-Host ("     title='{0}'  class={1}" -f $w.Title, $w.Cls) -ForegroundColor Gray
  Write-Host ("     rect={0}" -f $w.Rect) -ForegroundColor Gray
  Write-Host ("     exStyles: {0}" -f (Flags $w.Ex)) -ForegroundColor Gray
  $taskbar = if (($w.Ex -band 0x00008000) -and -not ($w.Ex -band 0x00000020)) { 'hidden from taskbar + Alt-Tab' }
             elseif ($w.Vis) { 'TASKBAR / ALT-TAB ENTRY PRESENT' } else { 'not shown' }
  Write-Host ("     shell visibility: {0}" -f $taskbar) -ForegroundColor Magenta
}

# ---------- 3. audio ----------
Write-Host "`n[3] AUDIO (visible to WASAPI session enumeration / sound-device inventory)" -ForegroundColor Yellow
try {
  $devs = Get-CimInstance Win32_SoundDevice | Where-Object { $_.Name -notmatch 'Microsoft.*(Remote|Loopback)' -or $_.Name -match 'Microphone|Realtek' }
  foreach ($d in $devs | Select-Object -First 6) { Write-Host ("  device: {0}" -f $d.Name) -ForegroundColor Gray }
} catch { Write-Host "  (could not enumerate sound devices)" -ForegroundColor DarkGray }
Write-Host "  NOTE: WASAPI session clients are only visible to code that queries IAudioSessionManager2." -ForegroundColor DarkGray
Write-Host "        The app holds a microphone stream ONLY while listening is on (tracks are stopped on stop)." -ForegroundColor DarkGray

# ---------- 4. network ----------
Write-Host "`n[4] OUTBOUND CONNECTIONS (visible to netstat / Get-NetTCPConnection / proxy logs)" -ForegroundColor Yellow
foreach ($p in $procs) {
  $conns = Get-NetTCPConnection -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue |
           Where-Object { $_.State -eq 'Established' -and $_.RemoteAddress -ne '127.0.0.1' }
  foreach ($c in $conns) {
    $host = try { (Resolve-DnsName -Name $c.RemoteAddress -Type PTR -ErrorAction Stop | Select-Object -First 1).NameHost } catch { $c.RemoteAddress }
    Write-Host ("  pid={0} -> {1}:{2}  ({3})" -f $p.ProcessId, $host, $c.RemotePort, $c.RemoteAddress) -ForegroundColor White
  }
}

Write-Host "`n------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "SUMMARY: sections 1-2 and 4 are the surfaces an assessor with machine" -ForegroundColor Cyan
Write-Host "access can read directly. Section 3 requires an audio-session query." -ForegroundColor Cyan
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan
